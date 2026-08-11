import { Test, TestingModule } from '@nestjs/testing';
import { Logger, NotFoundException } from '@nestjs/common';
import { EmailStatus, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  RECOMPUTE_LIMIT_TTL_SECONDS,
  REPUTATION_REDIS,
  SENT_EMAIL_STATUSES,
} from './reputation.constants';
import { ReputationService } from './reputation.service';

/** Instant figé : les fenêtres et les anciennetés deviennent déterministes. */
const NOW = new Date('2026-08-11T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** `createdAt` d'un compte âgé de `days` jours. */
function agedDays(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** Lignes telles que `groupBy({ by: ['status'], _count: { _all: true } })`. */
function statusRows(
  counts: Partial<Record<EmailStatus, number>>,
): { status: EmailStatus; _count: { _all: number } }[] {
  return Object.entries(counts).map(([status, total]) => ({
    status: status as EmailStatus,
    _count: { _all: total },
  }));
}

describe('ReputationService', () => {
  let service: ReputationService;

  const groupBy = jest.fn();
  const count = jest.fn();
  const userFindUnique = jest.fn();
  const userUpdate = jest.fn();
  const redisSet = jest.fn();

  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  /** Fait répondre `findUnique` avec un client par défaut surchargeable. */
  function givenUser(overrides: Record<string, unknown> = {}): void {
    userFindUnique.mockResolvedValue({
      id: 'user_1',
      email: 'contact@boutique-awa.gn',
      status: UserStatus.ACTIVE,
      dailySendLimit: 200,
      createdAt: agedDays(1),
      ...overrides,
    });
  }

  beforeAll(() => {
    // Horloge figée : fenêtre de 30 jours et anciennetés déterministes.
    // `Date.now` suffit — pas de faux timers, le service n'en pose aucun.
    jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warnLog = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    givenUser();
    groupBy.mockResolvedValue([]);
    count.mockResolvedValue(0);
    userUpdate.mockResolvedValue({ id: 'user_1' });
    redisSet.mockResolvedValue('OK');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReputationService,
        {
          provide: PrismaService,
          useValue: {
            email: { groupBy, count },
            user: { findUnique: userFindUnique, update: userUpdate },
          },
        },
        { provide: REPUTATION_REDIS, useValue: { set: redisSet } },
      ],
    }).compile();

    service = module.get(ReputationService);
  });

  describe('evaluate', () => {
    it('counts only the emails that really left, over the last 30 days', async () => {
      groupBy.mockResolvedValue(
        statusRows({
          [EmailStatus.SENT]: 40,
          [EmailStatus.DELIVERED]: 50,
          [EmailStatus.BOUNCED]: 8,
          [EmailStatus.COMPLAINED]: 2,
        }),
      );

      const metrics = await service.evaluate('user_1');

      expect(groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: {
          userId: 'user_1',
          queuedAt: { gte: new Date(NOW.getTime() - 30 * DAY_MS) },
          status: { in: [...SENT_EMAIL_STATUSES] },
        },
        _count: { _all: true },
      });
      expect(metrics).toMatchObject({
        sent: 100,
        bounces: 8,
        complaints: 2,
        bounceRate: 0.08,
        complaintRate: 0.02,
      });
    });

    it('reports zero rates (never NaN) when nothing was sent', async () => {
      const metrics = await service.evaluate('user_1');

      expect(metrics).toEqual({
        sent: 0,
        bounces: 0,
        complaints: 0,
        bounceRate: 0,
        complaintRate: 0,
        verdict: 'OK',
      });
      expect(userUpdate).not.toHaveBeenCalled();
    });

    // Le garde-fou qui évite de suspendre un client tout neuf sur un accident.
    it('never sanctions under the minimum volume, even at 100 % bounces', async () => {
      groupBy.mockResolvedValue(statusRows({ [EmailStatus.BOUNCED]: 49 }));

      const metrics = await service.evaluate('user_1');

      expect(metrics.bounceRate).toBe(1);
      expect(metrics.verdict).toBe('OK');
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('suspends the account at 6 % bounces over 100 sends', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 94, [EmailStatus.BOUNCED]: 6 }),
      );

      const metrics = await service.evaluate('user_1');

      expect(metrics).toMatchObject({
        sent: 100,
        bounces: 6,
        bounceRate: 0.06,
        verdict: 'SUSPEND',
      });
      expect(userUpdate).toHaveBeenCalledWith({
        where: { id: 'user_1' },
        data: { status: UserStatus.SUSPENDED },
      });
    });

    it('suspends the account at 0,2 % complaints over 1 000 sends', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 998, [EmailStatus.COMPLAINED]: 2 }),
      );

      const metrics = await service.evaluate('user_1');

      expect(metrics).toMatchObject({
        sent: 1000,
        complaints: 2,
        complaintRate: 0.002,
        verdict: 'SUSPEND',
      });
      expect(userUpdate).toHaveBeenCalledWith({
        where: { id: 'user_1' },
        data: { status: UserStatus.SUSPENDED },
      });
    });

    it('logs the account, the rates and the counters when it suspends', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 94, [EmailStatus.BOUNCED]: 6 }),
      );

      await service.evaluate('user_1');

      expect(errorLog).toHaveBeenCalledTimes(1);
      const [line] = errorLog.mock.calls[0] as [string];
      expect(line).toContain('contact@boutique-awa.gn');
      expect(line).toContain('user_1');
      expect(line).toContain('100 envois');
      expect(line).toContain('6 rebonds');
      expect(line).toContain('6.00 %');
    });

    it('warns at 3 % bounces without suspending anything', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 97, [EmailStatus.BOUNCED]: 3 }),
      );

      const metrics = await service.evaluate('user_1');

      expect(metrics.verdict).toBe('WARNING');
      expect(userUpdate).not.toHaveBeenCalled();
      expect(warnLog).toHaveBeenCalledTimes(1);
      expect(errorLog).not.toHaveBeenCalled();
    });

    // Le seuil est un dépassement strict : pile 5 % alerte, sans sanctionner.
    it('warns but does not suspend exactly at the 5 % bounce threshold', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 95, [EmailStatus.BOUNCED]: 5 }),
      );

      const metrics = await service.evaluate('user_1');

      expect(metrics.verdict).toBe('WARNING');
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('stays OK below the warning threshold', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 98, [EmailStatus.BOUNCED]: 2 }),
      );

      const metrics = await service.evaluate('user_1');

      expect(metrics.verdict).toBe('OK');
      expect(userUpdate).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalled();
    });

    it('does not write again on an already suspended account', async () => {
      givenUser({ status: UserStatus.SUSPENDED });
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 94, [EmailStatus.BOUNCED]: 6 }),
      );

      const metrics = await service.evaluate('user_1');

      expect(metrics.verdict).toBe('SUSPEND');
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('rejects an unknown user', async () => {
      userFindUnique.mockResolvedValue(null);

      await expect(service.evaluate('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('overview', () => {
    it('returns the metrics along with the account state', async () => {
      givenUser({ dailySendLimit: 5_000 });
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 98, [EmailStatus.BOUNCED]: 2 }),
      );

      const overview = await service.overview('user_1');

      expect(overview).toEqual({
        sent: 100,
        bounces: 2,
        complaints: 0,
        bounceRate: 0.02,
        complaintRate: 0,
        verdict: 'OK',
        dailySendLimit: 5_000,
        status: UserStatus.ACTIVE,
      });
    });

    it('reports the suspension it just triggered', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 94, [EmailStatus.BOUNCED]: 6 }),
      );

      const overview = await service.overview('user_1');

      expect(overview.verdict).toBe('SUSPEND');
      expect(overview.status).toBe(UserStatus.SUSPENDED);
    });
  });

  describe('recomputeDailyLimit', () => {
    /** Compte sain : aucun rebond, aucune plainte sur la fenêtre. */
    function healthyWindow(sent: number): void {
      groupBy.mockResolvedValue(statusRows({ [EmailStatus.SENT]: sent }));
    }

    it('keeps the default limit for an account younger than 3 days', async () => {
      givenUser({ createdAt: agedDays(2), dailySendLimit: 200 });
      healthyWindow(500);
      count.mockResolvedValue(500);

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBe(200);

      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('raises to 1 000/day at 3 days and 100 cumulative sends', async () => {
      givenUser({ createdAt: agedDays(3), dailySendLimit: 200 });
      healthyWindow(100);
      count.mockResolvedValue(100);

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBe(1_000);

      expect(count).toHaveBeenCalledWith({
        where: { userId: 'user_1', status: { in: [...SENT_EMAIL_STATUSES] } },
      });
      expect(userUpdate).toHaveBeenCalledWith({
        where: { id: 'user_1' },
        data: { dailySendLimit: 1_000 },
      });
    });

    it('raises to 5 000/day at 7 days and 1 000 cumulative sends', async () => {
      givenUser({ createdAt: agedDays(7), dailySendLimit: 1_000 });
      healthyWindow(1_000);
      count.mockResolvedValue(1_000);

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBe(5_000);

      expect(userUpdate).toHaveBeenCalledWith({
        where: { id: 'user_1' },
        data: { dailySendLimit: 5_000 },
      });
    });

    it('raises to 20 000/day at 30 days and 10 000 cumulative sends', async () => {
      givenUser({ createdAt: agedDays(30), dailySendLimit: 5_000 });
      healthyWindow(10_000);
      count.mockResolvedValue(10_000);

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBe(20_000);

      expect(userUpdate).toHaveBeenCalledWith({
        where: { id: 'user_1' },
        data: { dailySendLimit: 20_000 },
      });
    });

    it('holds the lower tier when age is reached but volume is not', async () => {
      givenUser({ createdAt: agedDays(40), dailySendLimit: 200 });
      healthyWindow(120);
      count.mockResolvedValue(120);

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBe(1_000);
    });

    // La limite ne redescend jamais toute seule : un client qui a ralenti
    // garde la capacité qu'il a gagnée.
    it('never lowers a limit already granted', async () => {
      givenUser({ createdAt: agedDays(3), dailySendLimit: 5_000 });
      healthyWindow(100);
      count.mockResolvedValue(100);

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBe(5_000);

      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('freezes the elevation while the verdict is WARNING', async () => {
      givenUser({ createdAt: agedDays(30), dailySendLimit: 200 });
      groupBy.mockResolvedValue(
        statusRows({
          [EmailStatus.SENT]: 9_700,
          [EmailStatus.BOUNCED]: 300,
        }),
      );
      count.mockResolvedValue(10_000);

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBe(200);

      expect(userUpdate).not.toHaveBeenCalled();
      // Le compte du volume cumulé n'est même pas payé.
      expect(count).not.toHaveBeenCalled();
    });

    it('suspends instead of elevating when a threshold is crossed', async () => {
      givenUser({ createdAt: agedDays(30), dailySendLimit: 200 });
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 9_400, [EmailStatus.BOUNCED]: 600 }),
      );

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBe(200);

      expect(userUpdate).toHaveBeenCalledTimes(1);
      expect(userUpdate).toHaveBeenCalledWith({
        where: { id: 'user_1' },
        data: { status: UserStatus.SUSPENDED },
      });
    });

    it('takes the hourly Redis slot before doing any work', async () => {
      givenUser({ createdAt: agedDays(3) });
      healthyWindow(100);
      count.mockResolvedValue(100);

      await service.recomputeDailyLimit('user_1');

      expect(redisSet).toHaveBeenCalledWith(
        'replimit:user_1',
        '1',
        'EX',
        RECOMPUTE_LIMIT_TTL_SECONDS,
        'NX',
      );
    });

    it('skips the second recompute within the hour', async () => {
      givenUser({ createdAt: agedDays(3) });
      healthyWindow(100);
      count.mockResolvedValue(100);
      redisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBe(1_000);
      jest.clearAllMocks();
      redisSet.mockResolvedValue(null);

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBeNull();

      expect(userFindUnique).not.toHaveBeenCalled();
      expect(groupBy).not.toHaveBeenCalled();
      expect(userUpdate).not.toHaveBeenCalled();
    });
  });
});

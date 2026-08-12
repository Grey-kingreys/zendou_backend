import { Test, TestingModule } from '@nestjs/testing';
import { Logger, NotFoundException } from '@nestjs/common';
import { EmailStatus, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  permanentBounceFixture,
  transientBounceFixture,
} from '../sns-webhook/fixtures';
import { buildBounceErrorMessage } from '../sns-webhook/sns-webhook.service';
import type {
  SesEventPayload,
  SnsMessage,
} from '../sns-webhook/sns-webhook.types';
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

/** Événement SES transporté par une fixture SNS. */
function sesPayload(message: SnsMessage): SesEventPayload {
  return JSON.parse(message.Message) as SesEventPayload;
}

/**
 * Écriture attendue d'une suspension automatique. `suspendedAt` est un
 * `new Date()` réel — l'horloge figée porte sur `Date.now`, que `new Date()`
 * ne consulte pas — et le motif est vérifié dans son propre test.
 */
const SUSPENSION_WRITE = {
  where: { id: 'user_1' },
  data: {
    status: UserStatus.SUSPENDED,
    suspendedAt: expect.any(Date) as unknown as Date,
    suspensionReason: expect.any(String) as unknown as string,
  },
};

describe('ReputationService', () => {
  let service: ReputationService;

  const groupBy = jest.fn();
  const count = jest.fn();
  const userFindUnique = jest.fn();
  const userUpdate = jest.fn();
  const redisSet = jest.fn();

  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  /**
   * `email.count` sert deux comptages ciblés : les rebonds durs de la fenêtre
   * (évaluation) et le volume cumulé (paliers de quota). Une évaluation ne
   * compte les rebonds durs que si la fenêtre contient au moins un rebond, et
   * un recalcul de quota ne compte le volume cumulé que sur un verdict `OK` —
   * les deux usages ne se croisent donc jamais dans un même test.
   */
  function givenHardBounces(total: number): void {
    count.mockResolvedValue(total);
  }

  /** Fait répondre `findUnique` avec un client par défaut surchargeable. */
  function givenUser(overrides: Record<string, unknown> = {}): void {
    userFindUnique.mockResolvedValue({
      id: 'user_1',
      email: 'contact@boutique-awa.gn',
      status: UserStatus.ACTIVE,
      dailySendLimit: 200,
      reputationResetAt: null,
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
      givenHardBounces(8);

      const metrics = await service.evaluate('user_1');

      expect(groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: {
          userId: 'user_1',
          // Les envois système (confirmation d'adresse) sont hors métrique :
          // ni au numérateur, ni au dénominateur.
          system: false,
          queuedAt: { gte: new Date(NOW.getTime() - 30 * DAY_MS) },
          status: { in: [...SENT_EMAIL_STATUSES] },
        },
        _count: { _all: true },
      });
      expect(metrics).toMatchObject({
        sent: 100,
        bounces: 8,
        hardBounces: 8,
        transientBounces: 0,
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
        hardBounces: 0,
        transientBounces: 0,
        complaints: 0,
        bounceRate: 0,
        complaintRate: 0,
        verdict: 'OK',
      });
      expect(userUpdate).not.toHaveBeenCalled();
      // Aucun rebond dans la fenêtre : le comptage ciblé n'est pas payé.
      expect(count).not.toHaveBeenCalled();
    });

    // Le garde-fou qui évite de suspendre un client tout neuf sur un accident.
    it('never sanctions under the minimum volume, even at 100 % bounces', async () => {
      groupBy.mockResolvedValue(statusRows({ [EmailStatus.BOUNCED]: 49 }));
      givenHardBounces(49);

      const metrics = await service.evaluate('user_1');

      expect(metrics.bounceRate).toBe(1);
      expect(metrics.verdict).toBe('OK');
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('suspends the account at 6 % hard bounces over 100 sends', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 94, [EmailStatus.BOUNCED]: 6 }),
      );
      givenHardBounces(6);

      const metrics = await service.evaluate('user_1');

      expect(metrics).toMatchObject({
        sent: 100,
        bounces: 6,
        hardBounces: 6,
        bounceRate: 0.06,
        verdict: 'SUSPEND',
      });
      expect(userUpdate).toHaveBeenCalledWith(SUSPENSION_WRITE);
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
      expect(userUpdate).toHaveBeenCalledWith(SUSPENSION_WRITE);
    });

    it('logs the account, the rates and the counters when it suspends', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 94, [EmailStatus.BOUNCED]: 6 }),
      );
      givenHardBounces(6);

      await service.evaluate('user_1');

      expect(errorLog).toHaveBeenCalledTimes(1);
      const [line] = errorLog.mock.calls[0] as [string];
      expect(line).toContain('contact@boutique-awa.gn');
      expect(line).toContain('user_1');
      expect(line).toContain('100 envois');
      expect(line).toContain('6 rebonds durs');
      expect(line).toContain('6.00 %');
      expect(line).toContain('0 transitoires ignorés');
    });

    it('warns at 3 % bounces without suspending anything', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 97, [EmailStatus.BOUNCED]: 3 }),
      );
      givenHardBounces(3);

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
      givenHardBounces(5);

      const metrics = await service.evaluate('user_1');

      expect(metrics.verdict).toBe('WARNING');
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('stays OK below the warning threshold', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 98, [EmailStatus.BOUNCED]: 2 }),
      );
      givenHardBounces(2);

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
      givenHardBounces(6);

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

  /**
   * Le taux sanctionné ne compte que les rebonds durs : une boîte pleine
   * n'est pas une faute de l'expéditeur, et AWS l'exclut lui aussi du taux
   * sur lequel il suspend un compte.
   */
  describe('hard bounces vs transient bounces', () => {
    it('never suspends on transient bounces alone (10 over 60 sends)', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 50, [EmailStatus.BOUNCED]: 10 }),
      );
      givenHardBounces(0);

      const metrics = await service.evaluate('user_1');

      expect(metrics).toEqual({
        sent: 60,
        bounces: 10,
        hardBounces: 0,
        transientBounces: 10,
        complaints: 0,
        bounceRate: 0,
        complaintRate: 0,
        verdict: 'OK',
      });
      expect(userUpdate).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('still suspends on 4 hard bounces over 60 sends', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 56, [EmailStatus.BOUNCED]: 4 }),
      );
      givenHardBounces(4);

      const metrics = await service.evaluate('user_1');

      expect(metrics).toMatchObject({
        sent: 60,
        hardBounces: 4,
        transientBounces: 0,
        verdict: 'SUSPEND',
      });
      expect(metrics.bounceRate).toBeCloseTo(4 / 60, 10);
      expect(userUpdate).toHaveBeenCalledWith(SUSPENSION_WRITE);
    });

    it('suspends on the hard bounces only, transient ones just reported', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 46, [EmailStatus.BOUNCED]: 14 }),
      );
      givenHardBounces(4);

      const metrics = await service.evaluate('user_1');

      expect(metrics).toMatchObject({
        sent: 60,
        bounces: 14,
        hardBounces: 4,
        transientBounces: 10,
        verdict: 'SUSPEND',
      });
      // 6,67 % — le taux des 4 durs, pas les 23,33 % des 14 rebonds bruts.
      expect(metrics.bounceRate).toBeCloseTo(4 / 60, 10);

      const [line] = errorLog.mock.calls[0] as [string];
      expect(line).toContain('4 rebonds durs (6.67 %)');
      expect(line).toContain('10 transitoires ignorés');
    });

    /**
     * Écriture ↔ lecture : le lecteur relit le préfixe posé par le webhook.
     * Si le format écrit change sans que le filtre suive, ce test casse —
     * c'est tout l'intérêt de partir du builder réel et des fixtures réelles.
     */
    it('recognises as hard exactly what the webhook writes for a permanent bounce', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 59, [EmailStatus.BOUNCED]: 1 }),
      );
      givenHardBounces(1);

      await service.evaluate('user_1');

      const [query] = count.mock.calls[0] as [
        { where: { errorMessage: { startsWith: string } } },
      ];
      const readPrefix = query.where.errorMessage.startsWith;

      const written = buildBounceErrorMessage(
        sesPayload(permanentBounceFixture()),
      );
      const transient = buildBounceErrorMessage(
        sesPayload(transientBounceFixture()),
      );

      expect(written.startsWith(readPrefix)).toBe(true);
      expect(transient.startsWith(readPrefix)).toBe(false);
    });
  });

  describe('suspension bookkeeping', () => {
    it('records suspendedAt and a reason naming the rate and the threshold', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 56, [EmailStatus.BOUNCED]: 4 }),
      );
      givenHardBounces(4);

      await service.evaluate('user_1');

      const [write] = userUpdate.mock.calls[0] as [
        { data: { suspendedAt: Date; suspensionReason: string } },
      ];
      expect(write.data.suspendedAt).toBeInstanceOf(Date);
      // 4 rebonds durs sur 60 envois = 6,67 %, au-dessus des 5 % tolérés.
      expect(write.data.suspensionReason).toBe(
        'Suspension automatique — taux de rebonds durs 6.67 % (4/60, seuil 5.00 %)',
      );
    });

    it('names the complaint threshold when it is the one crossed', async () => {
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 998, [EmailStatus.COMPLAINED]: 2 }),
      );

      await service.evaluate('user_1');

      const [write] = userUpdate.mock.calls[0] as [
        { data: { suspensionReason: string } },
      ];
      expect(write.data.suspensionReason).toBe(
        'Suspension automatique — taux de plaintes 0.20 % (2/1000, seuil 0.10 %)',
      );
    });
  });

  /**
   * Réactivation administrative : `reputationResetAt` borne la fenêtre par le
   * bas. Sans cela, un compte rouvert traînerait les rebonds qui l'ont fait
   * suspendre et serait re-suspendu au premier événement suivant — la
   * réactivation ne serait que décorative.
   */
  describe('reputation reset window', () => {
    const RESET_AT = new Date(NOW.getTime() - 1 * DAY_MS);
    /** Les 10 rebonds durs qui ont motivé la suspension, il y a 5 jours. */
    const BEFORE_RESET = new Date(NOW.getTime() - 5 * DAY_MS);
    /** Les 60 envois propres postérieurs à la réactivation. */
    const AFTER_RESET = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);

    interface FakeEmail {
      status: EmailStatus;
      queuedAt: Date;
      hard: boolean;
    }

    /**
     * Base simulée : ce que la fenêtre demandée sélectionne décide de tout.
     * Le même jeu de données donne SUSPEND sans remise à zéro et OK avec —
     * c'est exactement la propriété qu'on veut prouver.
     */
    function givenHistory(): void {
      const emails: FakeEmail[] = [
        ...Array.from({ length: 10 }, () => ({
          status: EmailStatus.BOUNCED,
          queuedAt: BEFORE_RESET,
          hard: true,
        })),
        ...Array.from({ length: 60 }, () => ({
          status: EmailStatus.SENT,
          queuedAt: AFTER_RESET,
          hard: false,
        })),
      ];

      const inWindow = (since: Date): FakeEmail[] =>
        emails.filter((email) => email.queuedAt >= since);

      groupBy.mockImplementation(
        (args: { where: { queuedAt: { gte: Date } } }) =>
          Promise.resolve(
            statusRows(
              inWindow(args.where.queuedAt.gte).reduce<
                Partial<Record<EmailStatus, number>>
              >((counts, email) => {
                counts[email.status] = (counts[email.status] ?? 0) + 1;
                return counts;
              }, {}),
            ),
          ),
      );

      count.mockImplementation((args: { where: { queuedAt: { gte: Date } } }) =>
        Promise.resolve(
          inWindow(args.where.queuedAt.gte).filter((email) => email.hard)
            .length,
        ),
      );
    }

    it('lowers the window bound to reputationResetAt when it is more recent', async () => {
      givenUser({ reputationResetAt: RESET_AT });
      givenHistory();

      await service.evaluate('user_1');

      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            queuedAt: { gte: RESET_AT },
          }) as unknown,
        }),
      );
    });

    it('keeps the 30-day window when the reset is older than it', async () => {
      givenUser({ reputationResetAt: new Date(NOW.getTime() - 90 * DAY_MS) });
      givenHistory();

      await service.evaluate('user_1');

      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            queuedAt: { gte: new Date(NOW.getTime() - 30 * DAY_MS) },
          }) as unknown,
        }),
      );
    });

    it('re-suspends the very same history when no reset was ever posted', async () => {
      givenUser({ reputationResetAt: null });
      givenHistory();

      const metrics = await service.evaluate('user_1');

      expect(metrics).toMatchObject({
        sent: 70,
        hardBounces: 10,
        verdict: 'SUSPEND',
      });
      expect(userUpdate).toHaveBeenCalledWith(SUSPENSION_WRITE);
    });

    it('verdicts OK on a reactivated account whose 10 hard bounces predate the reset', async () => {
      givenUser({ reputationResetAt: RESET_AT });
      givenHistory();

      const metrics = await service.evaluate('user_1');

      expect(metrics).toEqual({
        sent: 60,
        bounces: 0,
        hardBounces: 0,
        transientBounces: 0,
        complaints: 0,
        bounceRate: 0,
        complaintRate: 0,
        verdict: 'OK',
      });
      expect(userUpdate).not.toHaveBeenCalled();
    });
  });

  describe('overview', () => {
    it('returns the metrics along with the account state', async () => {
      givenUser({ dailySendLimit: 5_000 });
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 96, [EmailStatus.BOUNCED]: 4 }),
      );
      givenHardBounces(2);

      const overview = await service.overview('user_1');

      expect(overview).toEqual({
        sent: 100,
        bounces: 4,
        hardBounces: 2,
        transientBounces: 2,
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
      givenHardBounces(6);

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
        where: {
          userId: 'user_1',
          system: false,
          status: { in: [...SENT_EMAIL_STATUSES] },
        },
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
      givenHardBounces(300);

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBe(200);

      expect(userUpdate).not.toHaveBeenCalled();
      // Le compte du volume cumulé n'est même pas payé (seul celui des
      // rebonds durs, nécessaire au verdict, a été émis).
      expect(count).not.toHaveBeenCalledWith({
        where: {
          userId: 'user_1',
          system: false,
          status: { in: [...SENT_EMAIL_STATUSES] },
        },
      });
    });

    it('suspends instead of elevating when a threshold is crossed', async () => {
      givenUser({ createdAt: agedDays(30), dailySendLimit: 200 });
      groupBy.mockResolvedValue(
        statusRows({ [EmailStatus.SENT]: 9_400, [EmailStatus.BOUNCED]: 600 }),
      );
      givenHardBounces(600);

      await expect(service.recomputeDailyLimit('user_1')).resolves.toBe(200);

      expect(userUpdate).toHaveBeenCalledTimes(1);
      expect(userUpdate).toHaveBeenCalledWith(SUSPENSION_WRITE);
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

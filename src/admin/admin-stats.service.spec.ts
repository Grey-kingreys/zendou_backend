import { Test, TestingModule } from '@nestjs/testing';
import { EmailStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminStatsService } from './admin-stats.service';

const NOW = new Date('2026-08-13T15:30:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('AdminStatsService', () => {
  let service: AdminStatsService;

  const emailGroupBy = jest.fn();

  const prisma = {
    email: { groupBy: emailGroupBy },
  };

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    emailGroupBy.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminStatsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AdminStatsService>(AdminStatsService);
  });

  it('costs exactly 5 grouped Prisma queries, run in parallel (no N+1)', async () => {
    await service.emailStats();

    expect(emailGroupBy).toHaveBeenCalledTimes(5);
  });

  /**
   * Le cœur du contrat : `all` n'est jamais un troisième chiffre qui
   * pourrait diverger, c'est la somme de `system` et `client`. On le
   * vérifie sur un jeu où les trois valeurs sont non nulles.
   */
  it('enforces all = system + client on data where all three are non-zero', async () => {
    emailGroupBy
      .mockResolvedValueOnce([
        { system: true, _count: { _all: 30 } },
        { system: false, _count: { _all: 970 } },
      ]) // total
      .mockResolvedValueOnce([
        { system: true, _count: { _all: 2 } },
        { system: false, _count: { _all: 18 } },
      ]) // today
      .mockResolvedValueOnce([
        { system: true, _count: { _all: 10 } },
        { system: false, _count: { _all: 140 } },
      ]) // last7d
      .mockResolvedValueOnce([
        { system: true, _count: { _all: 25 } },
        { system: false, _count: { _all: 600 } },
      ]) // last30d
      .mockResolvedValueOnce([]); // byStatus

    const stats = await service.emailStats();

    expect(stats.total).toEqual({ all: 1000, system: 30, client: 970 });
    expect(stats.today).toEqual({ all: 20, system: 2, client: 18 });
    expect(stats.last7d).toEqual({ all: 150, system: 10, client: 140 });
    expect(stats.last30d).toEqual({ all: 625, system: 25, client: 600 });

    for (const window of [
      stats.total,
      stats.today,
      stats.last7d,
      stats.last30d,
    ]) {
      expect(window.all).toBe(window.system + window.client);
    }
  });

  it('defaults a missing system/client side to zero rather than dropping the key', async () => {
    emailGroupBy.mockResolvedValueOnce([
      { system: false, _count: { _all: 12 } },
    ]); // total: no system row at all

    const stats = await service.emailStats();

    expect(stats.total).toEqual({ all: 12, system: 0, client: 12 });
  });

  it('fills every EmailStatus value, including the ones absent from the rows', async () => {
    emailGroupBy
      .mockResolvedValueOnce([]) // total
      .mockResolvedValueOnce([]) // today
      .mockResolvedValueOnce([]) // last7d
      .mockResolvedValueOnce([]) // last30d
      .mockResolvedValueOnce([
        { status: EmailStatus.SENT, _count: { _all: 5 } },
        { status: EmailStatus.BOUNCED, _count: { _all: 1 } },
      ]);

    const stats = await service.emailStats();

    expect(stats.byStatus).toEqual({
      QUEUED: 0,
      SENT: 5,
      DELIVERED: 0,
      BOUNCED: 1,
      COMPLAINED: 0,
      REJECTED: 0,
      FAILED: 0,
      SUPPRESSED: 0,
    });
    expect(Object.keys(stats.byStatus).sort()).toEqual(
      Object.values(EmailStatus).sort(),
    );
  });

  it('queries today from UTC midnight (Guinée = UTC+0, sans heure d’été)', async () => {
    await service.emailStats();

    const todayCall = emailGroupBy.mock.calls[1] as [
      { where: { queuedAt: { gte: Date } } },
    ];
    expect(todayCall[0].where.queuedAt.gte).toEqual(
      new Date('2026-08-13T00:00:00.000Z'),
    );
  });

  it('queries the 7-day and 30-day windows as rolling windows from now', async () => {
    await service.emailStats();

    const last7dCall = emailGroupBy.mock.calls[2] as [
      { where: { queuedAt: { gte: Date } } },
    ];
    const last30dCall = emailGroupBy.mock.calls[3] as [
      { where: { queuedAt: { gte: Date } } },
    ];

    expect(last7dCall[0].where.queuedAt.gte).toEqual(
      new Date(NOW.getTime() - 7 * DAY_MS),
    );
    expect(last30dCall[0].where.queuedAt.gte).toEqual(
      new Date(NOW.getTime() - 30 * DAY_MS),
    );
  });

  it('does not filter total or byStatus by queuedAt (all-time)', async () => {
    await service.emailStats();

    const totalCall = emailGroupBy.mock.calls[0] as [{ where?: unknown }];
    const statusCall = emailGroupBy.mock.calls[4] as [{ where?: unknown }];

    expect(totalCall[0].where).toBeUndefined();
    expect(statusCall[0].where).toBeUndefined();
  });

  it('stamps generatedAt with the current time', async () => {
    const stats = await service.emailStats();

    expect(stats.generatedAt).toEqual(NOW);
  });
});

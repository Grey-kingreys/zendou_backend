import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminActionType,
  DomainStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { SessionService } from '../auth';
import { CREDIT_REASON_WELCOME_BONUS } from '../billing/billing.constants';
import { PrismaService } from '../prisma/prisma.service';
import { SENT_EMAIL_STATUSES } from '../reputation/reputation.constants';
import { AdminUsersService } from './admin-users.service';
import {
  CREDIT_REASON_ADMIN_GRANT,
  SELF_CREDIT_MESSAGE,
  SELF_DELETE_MESSAGE,
  SELF_SUSPEND_MESSAGE,
  USER_ALREADY_ACTIVE_MESSAGE,
  USER_ALREADY_SUSPENDED_MESSAGE,
  USER_NOT_FOUND_MESSAGE,
} from './admin.constants';

const NOW = new Date('2026-08-11T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ligne `User` telle que la sélection de la liste la renvoie. */
function userRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id}@boutique-awa.gn`,
    name: `Client ${id}`,
    company: 'Boutique Awa',
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    dailySendLimit: 200,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    suspendedAt: null,
    ...overrides,
  };
}

describe('AdminUsersService', () => {
  let service: AdminUsersService;

  const userFindMany = jest.fn();
  const userCount = jest.fn();
  const userFindUnique = jest.fn();
  const userUpdate = jest.fn();
  const userDelete = jest.fn();
  const creditGroupBy = jest.fn();
  const creditAggregate = jest.fn();
  const creditCreate = jest.fn();
  const creditEntryCount = jest.fn();
  const creditEntryDeleteMany = jest.fn();
  const emailGroupBy = jest.fn();
  const emailCount = jest.fn();
  const emailDeleteMany = jest.fn();
  const domainGroupBy = jest.fn();
  const domainCount = jest.fn();
  const apiKeyCount = jest.fn();
  const topUpRequestCount = jest.fn();
  const actionCreate = jest.fn();
  const actionFindMany = jest.fn();
  const actionCount = jest.fn();
  const $transaction = jest.fn();
  const destroyAllForUser = jest.fn();

  /** Tous les appels Prisma du service, pour compter le coût d'une page. */
  const prismaCalls = [
    userFindMany,
    userCount,
    userFindUnique,
    userUpdate,
    userDelete,
    creditGroupBy,
    creditAggregate,
    creditCreate,
    creditEntryCount,
    creditEntryDeleteMany,
    emailGroupBy,
    emailCount,
    emailDeleteMany,
    domainGroupBy,
    domainCount,
    apiKeyCount,
    topUpRequestCount,
    actionCreate,
    actionFindMany,
    actionCount,
  ];

  const totalPrismaCalls = (): number =>
    prismaCalls.reduce((total, mock) => total + mock.mock.calls.length, 0);

  const prisma = {
    user: {
      findMany: userFindMany,
      count: userCount,
      findUnique: userFindUnique,
      update: userUpdate,
      delete: userDelete,
    },
    creditEntry: {
      groupBy: creditGroupBy,
      aggregate: creditAggregate,
      create: creditCreate,
      count: creditEntryCount,
      deleteMany: creditEntryDeleteMany,
    },
    email: {
      groupBy: emailGroupBy,
      count: emailCount,
      deleteMany: emailDeleteMany,
    },
    domain: { groupBy: domainGroupBy, count: domainCount },
    apiKey: { count: apiKeyCount },
    topUpRequest: { count: topUpRequestCount },
    adminAction: {
      create: actionCreate,
      findMany: actionFindMany,
      count: actionCount,
    },
    $transaction,
  };

  const sessionService = { destroyAllForUser };

  beforeAll(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    userFindMany.mockResolvedValue([]);
    userCount.mockResolvedValue(0);
    creditGroupBy.mockResolvedValue([]);
    creditAggregate.mockResolvedValue({ _sum: { delta: 0 } });
    creditEntryCount.mockResolvedValue(0);
    emailGroupBy.mockResolvedValue([]);
    emailCount.mockResolvedValue(0);
    domainGroupBy.mockResolvedValue([]);
    domainCount.mockResolvedValue(0);
    apiKeyCount.mockResolvedValue(0);
    topUpRequestCount.mockResolvedValue(0);
    actionFindMany.mockResolvedValue([]);
    actionCreate.mockResolvedValue({ id: 'action_1' });
    actionCount.mockResolvedValue(0);
    destroyAllForUser.mockResolvedValue(undefined);
    $transaction.mockImplementation(
      (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: SessionService, useValue: sessionService },
      ],
    }).compile();

    service = module.get<AdminUsersService>(AdminUsersService);
  });

  describe('list', () => {
    it('paginates with the module defaults', async () => {
      userCount.mockResolvedValue(52);

      const result = await service.list({});

      expect(userFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 25, where: {} }),
      );
      expect(result).toMatchObject({
        total: 52,
        page: 1,
        limit: 25,
        totalPages: 3,
      });
    });

    it('honours page and limit', async () => {
      await service.list({ page: '3', limit: '10' });

      expect(userFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('rejects a limit above the ceiling', async () => {
      await expect(service.list({ limit: '500' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('filters on status and role', async () => {
      await service.list({ status: 'SUSPENDED', role: 'ADMIN' });

      expect(userFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: UserStatus.SUSPENDED, role: UserRole.ADMIN },
        }),
      );
    });

    it('rejects an unknown status', async () => {
      await expect(service.list({ status: 'ZOMBIE' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('searches email OR name, case-insensitively', async () => {
      await service.list({ q: '  AWA  ' });

      expect(userFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { email: { contains: 'AWA', mode: 'insensitive' } },
              { name: { contains: 'AWA', mode: 'insensitive' } },
            ],
          },
        }),
      );
    });

    it('counts the sends of the page over the last 30 days only', async () => {
      userFindMany.mockResolvedValue([userRow('u1')]);

      await service.list({});

      expect(emailGroupBy).toHaveBeenCalledWith({
        by: ['userId'],
        where: {
          userId: { in: ['u1'] },
          // Les emails que Zendou adresse au client ne sont pas des envois
          // du client : ils ne gonflent pas le KPI.
          system: false,
          queuedAt: { gte: new Date(NOW.getTime() - 30 * DAY_MS) },
          status: { in: [...SENT_EMAIL_STATUSES] },
        },
        _count: { _all: true },
      });
    });

    /**
     * Le point qui compte : le coût d'une page ne doit pas dépendre du nombre
     * de comptes qu'elle contient. Trois utilisateurs, quatre requêtes — les
     * mêmes quatre que pour vingt-cinq.
     */
    it('costs exactly 4 Prisma queries for a page of 3 users (no N+1)', async () => {
      userFindMany.mockResolvedValue([
        userRow('u1'),
        userRow('u2'),
        userRow('u3'),
      ]);
      userCount.mockResolvedValue(3);
      creditGroupBy.mockResolvedValue([
        { userId: 'u1', _sum: { delta: 10_000 } },
        { userId: 'u3', _sum: { delta: -50 } },
      ]);
      emailGroupBy.mockResolvedValue([{ userId: 'u2', _count: { _all: 42 } }]);

      const result = await service.list({});

      expect(totalPrismaCalls()).toBe(4);
      expect(userFindMany).toHaveBeenCalledTimes(1);
      expect(userCount).toHaveBeenCalledTimes(1);
      expect(creditGroupBy).toHaveBeenCalledTimes(1);
      expect(emailGroupBy).toHaveBeenCalledTimes(1);
      expect(creditAggregate).not.toHaveBeenCalled();
      expect(emailCount).not.toHaveBeenCalled();

      expect(
        result.items.map((item) => [
          item.id,
          item.creditBalance,
          item.emailsSent30d,
        ]),
      ).toEqual([
        ['u1', 10_000, 0],
        ['u2', 0, 42],
        ['u3', -50, 0],
      ]);
    });
  });

  describe('detail', () => {
    it('assembles the account file with its last audit lines', async () => {
      userFindUnique.mockResolvedValue({
        ...userRow('u1', {
          status: UserStatus.SUSPENDED,
          suspendedAt: NOW,
        }),
        suspensionReason: 'Rebonds durs 6.67 %',
        reputationResetAt: null,
        declaredUsage: 'Notifications de commande',
      });
      creditAggregate.mockResolvedValue({ _sum: { delta: 7_500 } });
      emailCount.mockResolvedValue(120);
      domainGroupBy.mockResolvedValue([
        { status: DomainStatus.VERIFIED, _count: { _all: 2 } },
        { status: DomainStatus.PENDING, _count: { _all: 1 } },
      ]);
      apiKeyCount.mockResolvedValue(3);
      actionFindMany.mockResolvedValue([{ id: 'action_9' }]);

      const detail = await service.detail('u1');

      expect(detail).toMatchObject({
        id: 'u1',
        creditBalance: 7_500,
        emailsSent30d: 120,
        domainsCount: 3,
        verifiedDomainsCount: 2,
        activeApiKeysCount: 3,
        suspensionReason: 'Rebonds durs 6.67 %',
        declaredUsage: 'Notifications de commande',
      });
      expect(detail.recentActions).toEqual([{ id: 'action_9' }]);
      expect(apiKeyCount).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
      });
      expect(actionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { targetUserId: 'u1' },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      );
    });

    it('throws 404 for an unknown account', async () => {
      userFindUnique.mockResolvedValue(null);

      await expect(service.detail('ghost')).rejects.toThrow(
        new NotFoundException(USER_NOT_FOUND_MESSAGE),
      );
    });
  });

  describe('suspend', () => {
    it('suspends, dates and motivates, then audits — in one transaction', async () => {
      userFindUnique.mockResolvedValue({
        id: 'u1',
        status: UserStatus.ACTIVE,
      });
      userUpdate.mockResolvedValue({
        id: 'u1',
        status: UserStatus.SUSPENDED,
        suspendedAt: NOW,
        suspensionReason: 'Envois non sollicités signalés',
        reputationResetAt: null,
      });

      const result = await service.suspend('admin_1', 'u1', {
        reason: 'Envois non sollicités signalés',
      });

      expect($transaction).toHaveBeenCalledTimes(1);
      const [write] = userUpdate.mock.calls[0] as [
        { where: { id: string }; data: Record<string, unknown> },
      ];
      expect(write.where).toEqual({ id: 'u1' });
      expect(write.data.status).toBe(UserStatus.SUSPENDED);
      expect(write.data.suspendedAt).toBeInstanceOf(Date);
      expect(write.data.suspensionReason).toBe(
        'Envois non sollicités signalés',
      );
      expect(actionCreate).toHaveBeenCalledWith({
        data: {
          adminId: 'admin_1',
          targetUserId: 'u1',
          type: AdminActionType.SUSPEND_USER,
          reason: 'Envois non sollicités signalés',
        },
        select: { id: true },
      });
      expect(result).toMatchObject({
        status: UserStatus.SUSPENDED,
        actionId: 'action_1',
      });
    });

    it('throws 409 on an already suspended account, writing nothing', async () => {
      userFindUnique.mockResolvedValue({
        id: 'u1',
        status: UserStatus.SUSPENDED,
      });

      await expect(
        service.suspend('admin_1', 'u1', { reason: 'Doublon' }),
      ).rejects.toThrow(new ConflictException(USER_ALREADY_SUSPENDED_MESSAGE));

      expect(userUpdate).not.toHaveBeenCalled();
      expect(actionCreate).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown account', async () => {
      userFindUnique.mockResolvedValue(null);

      await expect(
        service.suspend('admin_1', 'ghost', { reason: 'Peu importe' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses an admin suspending themselves, before touching the database', async () => {
      await expect(
        service.suspend('admin_1', 'admin_1', { reason: 'Erreur de saisie' }),
      ).rejects.toThrow(new BadRequestException(SELF_SUSPEND_MESSAGE));

      expect($transaction).not.toHaveBeenCalled();
      expect(totalPrismaCalls()).toBe(0);
    });
  });

  describe('reactivate', () => {
    beforeEach(() => {
      userFindUnique.mockResolvedValue({
        id: 'u1',
        status: UserStatus.SUSPENDED,
        suspensionReason:
          'Suspension automatique — taux de rebonds durs 6.67 %',
      });
      userUpdate.mockImplementation(
        (args: { data: { reputationResetAt: Date } }) =>
          Promise.resolve({
            id: 'u1',
            status: UserStatus.ACTIVE,
            suspendedAt: null,
            suspensionReason: null,
            reputationResetAt: args.data.reputationResetAt,
          }),
      );
    });

    /**
     * Le cœur de la tâche : sans `reputationResetAt`, le compte rouvert
     * traînerait les rebonds qui l'ont fait suspendre et serait re-suspendu
     * au premier événement suivant.
     */
    it('reopens the account and stamps reputationResetAt', async () => {
      const result = await service.reactivate('admin_1', 'u1', {});

      const [write] = userUpdate.mock.calls[0] as [
        { where: { id: string }; data: Record<string, unknown> },
      ];
      expect(write.where).toEqual({ id: 'u1' });
      expect(write.data.status).toBe(UserStatus.ACTIVE);
      expect(write.data.reputationResetAt).toBeInstanceOf(Date);
      expect(write.data.suspendedAt).toBeNull();
      expect(write.data.suspensionReason).toBeNull();

      expect(result.status).toBe(UserStatus.ACTIVE);
      expect(result.reputationResetAt).toBeInstanceOf(Date);
      expect(result.suspendedAt).toBeNull();
    });

    it('audits the reactivation with the reset stamp and the previous reason', async () => {
      await service.reactivate('admin_1', 'u1', {
        reason: 'Liste nettoyée, client de confiance',
      });

      expect($transaction).toHaveBeenCalledTimes(1);
      const [audit] = actionCreate.mock.calls[0] as [
        {
          data: {
            adminId: string;
            targetUserId: string;
            type: AdminActionType;
            reason: string | null;
            details: {
              reputationResetAt: string;
              previousSuspensionReason: string | null;
            };
          };
        },
      ];
      expect(audit.data.adminId).toBe('admin_1');
      expect(audit.data.targetUserId).toBe('u1');
      expect(audit.data.type).toBe(AdminActionType.REACTIVATE_USER);
      expect(audit.data.reason).toBe('Liste nettoyée, client de confiance');
      expect(audit.data.details.previousSuspensionReason).toContain(
        'Suspension automatique',
      );

      // La date auditée est exactement celle écrite sur le compte.
      const [write] = userUpdate.mock.calls[0] as [
        { data: { reputationResetAt: Date } },
      ];
      expect(audit.data.details.reputationResetAt).toBe(
        write.data.reputationResetAt.toISOString(),
      );
    });

    it('stores a null reason when the admin gave none', async () => {
      await service.reactivate('admin_1', 'u1', {});

      const [audit] = actionCreate.mock.calls[0] as [
        { data: { reason: string | null } },
      ];
      expect(audit.data.reason).toBeNull();
    });

    it('throws 409 on an already active account, writing nothing', async () => {
      userFindUnique.mockResolvedValue({
        id: 'u1',
        status: UserStatus.ACTIVE,
        suspensionReason: null,
      });

      await expect(service.reactivate('admin_1', 'u1', {})).rejects.toThrow(
        new ConflictException(USER_ALREADY_ACTIVE_MESSAGE),
      );

      expect(userUpdate).not.toHaveBeenCalled();
      expect(actionCreate).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown account', async () => {
      userFindUnique.mockResolvedValue(null);

      await expect(
        service.reactivate('admin_1', 'ghost', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateQuota', () => {
    it('writes the new limit and audits both values', async () => {
      userFindUnique.mockResolvedValue({ id: 'u1', dailySendLimit: 200 });
      userUpdate.mockResolvedValue({ id: 'u1', dailySendLimit: 5_000 });

      const result = await service.updateQuota('admin_1', 'u1', {
        dailySendLimit: 5_000,
      });

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(actionCreate).toHaveBeenCalledWith({
        data: {
          adminId: 'admin_1',
          targetUserId: 'u1',
          type: AdminActionType.ADJUST_QUOTA,
          details: { previousDailySendLimit: 200, dailySendLimit: 5_000 },
        },
        select: { id: true },
      });
      expect(result).toEqual({
        id: 'u1',
        dailySendLimit: 5_000,
        previousDailySendLimit: 200,
        actionId: 'action_1',
      });
    });

    it('throws 404 for an unknown account', async () => {
      userFindUnique.mockResolvedValue(null);

      await expect(
        service.updateQuota('admin_1', 'ghost', { dailySendLimit: 10 }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(userUpdate).not.toHaveBeenCalled();
    });
  });

  describe('grantCredits', () => {
    beforeEach(() => {
      userFindUnique.mockResolvedValue({ id: 'u1' });
      creditAggregate.mockResolvedValue({ _sum: { delta: 15_000 } });
    });

    it('writes the audit line and the ledger entry in a single transaction', async () => {
      const result = await service.grantCredits('admin_1', 'u1', {
        delta: 5_000,
        reason: 'Geste commercial — incident SES du 3 août',
      });

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(actionCreate).toHaveBeenCalledWith({
        data: {
          adminId: 'admin_1',
          targetUserId: 'u1',
          type: AdminActionType.GRANT_CREDITS,
          reason: 'Geste commercial — incident SES du 3 août',
          details: { delta: 5_000 },
        },
        select: { id: true },
      });
      // La ligne de ledger pointe vers l'action : depuis le relevé du client,
      // on remonte à l'admin et au motif.
      expect(creditCreate).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          delta: 5_000,
          reason: CREDIT_REASON_ADMIN_GRANT,
          reference: 'action_1',
        },
      });
      expect(result).toEqual({
        id: 'u1',
        delta: 5_000,
        creditBalance: 15_000,
        actionId: 'action_1',
      });
    });

    it('accepts a negative delta (taking back a credit granted by mistake)', async () => {
      creditAggregate.mockResolvedValue({ _sum: { delta: -200 } });

      const result = await service.grantCredits('admin_1', 'u1', {
        delta: -1_000,
        reason: 'Avoir accordé à tort',
      });

      expect(creditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ delta: -1_000 }) as unknown,
        }),
      );
      expect(result.creditBalance).toBe(-200);
    });

    it('refuses an admin crediting themselves, before touching the database', async () => {
      await expect(
        service.grantCredits('admin_1', 'admin_1', {
          delta: 100_000,
          reason: 'Pour mes tests',
        }),
      ).rejects.toThrow(new BadRequestException(SELF_CREDIT_MESSAGE));

      expect($transaction).not.toHaveBeenCalled();
      expect(totalPrismaCalls()).toBe(0);
    });

    it('throws 404 for an unknown account, writing no ledger entry', async () => {
      userFindUnique.mockResolvedValue(null);

      await expect(
        service.grantCredits('admin_1', 'ghost', {
          delta: 100,
          reason: 'Peu importe',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(actionCreate).not.toHaveBeenCalled();
      expect(creditCreate).not.toHaveBeenCalled();
    });
  });

  describe('deleteUser', () => {
    /**
     * `emailCount`/`creditEntryCount` sont chacun appelés deux fois dans
     * `deleteUser` : une fois filtrés pour le décompte des blocages
     * (`system: false` / `reason != WELCOME_BONUS`), une fois sans filtre
     * pour l'invariant post-cascade. Ce helper distingue les deux appels
     * par leur clause `where`, comme le ferait une vraie base : le second
     * appel voit l'effet du `deleteMany` simulé par `remainingAfterCascade`.
     */
    function mockEmailCounts(
      clientEmails: number,
      remainingAfterCascade: number,
    ) {
      emailCount.mockImplementation(
        ({ where }: { where: { system?: boolean } }) =>
          Promise.resolve(
            where.system === false ? clientEmails : remainingAfterCascade,
          ),
      );
    }

    function mockCreditEntryCounts(
      nonWelcomeEntries: number,
      remainingAfterCascade: number,
    ) {
      creditEntryCount.mockImplementation(
        ({ where }: { where: { reason?: unknown } }) =>
          Promise.resolve(
            'reason' in where ? nonWelcomeEntries : remainingAfterCascade,
          ),
      );
    }

    beforeEach(() => {
      userFindUnique.mockResolvedValue({
        id: 'u1',
        email: 'jean@gmial.com',
        name: 'Jean Camara',
      });
      emailDeleteMany.mockResolvedValue({ count: 0 });
      creditEntryDeleteMany.mockResolvedValue({ count: 0 });
    });

    it('deletes the account, audits it and revokes its sessions when nothing blocks', async () => {
      const result = await service.deleteUser('admin_1', 'u1');

      expect($transaction).toHaveBeenCalledTimes(1);

      // La ligne d'audit est écrite AVANT le hard delete (targetUserId
      // référence encore un compte existant à cet instant), et porte
      // l'email et le nom en dur dans `details` — seule donnée qui survit
      // une fois `targetUserId` mis à NULL par le SetNull de Postgres.
      expect(actionCreate).toHaveBeenCalledWith({
        data: {
          adminId: 'admin_1',
          targetUserId: 'u1',
          type: AdminActionType.DELETE_USER,
          details: {
            deletedUserEmail: 'jean@gmial.com',
            deletedUserName: 'Jean Camara',
          },
        },
        select: { id: true },
      });

      // Cascade : emails système et crédit de bienvenue supprimés
      // explicitement, dans la même transaction, avant le compte.
      expect(emailDeleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', system: true },
      });
      expect(creditEntryDeleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', reason: CREDIT_REASON_WELCOME_BONUS },
      });

      expect(userDelete).toHaveBeenCalledWith({ where: { id: 'u1' } });

      // L'ordre compte : audit, puis cascade, puis suppression du compte.
      const actionCreateOrder = actionCreate.mock.invocationCallOrder[0];
      const emailDeleteManyOrder = emailDeleteMany.mock.invocationCallOrder[0];
      const creditEntryDeleteManyOrder =
        creditEntryDeleteMany.mock.invocationCallOrder[0];
      const userDeleteOrder = userDelete.mock.invocationCallOrder[0];
      expect(actionCreateOrder).toBeLessThan(emailDeleteManyOrder);
      expect(actionCreateOrder).toBeLessThan(creditEntryDeleteManyOrder);
      expect(emailDeleteManyOrder).toBeLessThan(userDeleteOrder);
      expect(creditEntryDeleteManyOrder).toBeLessThan(userDeleteOrder);

      // Révocation Redis après le succès de la transaction, via l'index
      // inverse posé pour le changement de mot de passe (T16).
      expect(destroyAllForUser).toHaveBeenCalledWith('u1');

      expect(result).toEqual({
        id: 'u1',
        email: 'jean@gmial.com',
        actionId: 'action_1',
      });
    });

    it('refuses an admin deleting themselves, before touching the database', async () => {
      await expect(service.deleteUser('admin_1', 'admin_1')).rejects.toThrow(
        new BadRequestException(SELF_DELETE_MESSAGE),
      );

      expect($transaction).not.toHaveBeenCalled();
      expect(totalPrismaCalls()).toBe(0);
      expect(destroyAllForUser).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown account', async () => {
      userFindUnique.mockResolvedValue(null);

      await expect(
        service.deleteUser('admin_1', 'ghost'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(actionCreate).not.toHaveBeenCalled();
      expect(userDelete).not.toHaveBeenCalled();
      expect(destroyAllForUser).not.toHaveBeenCalled();
    });

    it.each([
      ['a domain', () => domainCount.mockResolvedValue(2), '2 domaines'],
      ['an API key', () => apiKeyCount.mockResolvedValue(1), '1 clé API'],
      [
        'a client email (system: false)',
        () => emailCount.mockResolvedValue(14),
        '14 emails',
      ],
      [
        'a non-welcome-bonus credit entry',
        () => creditEntryCount.mockResolvedValue(3),
        '3 mouvements de crédit',
      ],
      [
        'a top-up request',
        () => topUpRequestCount.mockResolvedValue(1),
        '1 demande de recharge',
      ],
      [
        'an admin action performed by the account',
        () => actionCount.mockResolvedValue(5),
        "5 actions d'administration effectuées en tant qu'admin",
      ],
    ])(
      'refuses with 409 when the account has %s, writing nothing',
      async (_label, arrange, expectedFragment) => {
        arrange();

        await expect(service.deleteUser('admin_1', 'u1')).rejects.toThrow(
          ConflictException,
        );
        await expect(service.deleteUser('admin_1', 'u1')).rejects.toThrow(
          expectedFragment,
        );

        expect(actionCreate).not.toHaveBeenCalled();
        expect(emailDeleteMany).not.toHaveBeenCalled();
        expect(creditEntryDeleteMany).not.toHaveBeenCalled();
        expect(userDelete).not.toHaveBeenCalled();
        expect(destroyAllForUser).not.toHaveBeenCalled();
      },
    );

    it('combines every blocking cause with its count in a single message', async () => {
      domainCount.mockResolvedValue(2);
      apiKeyCount.mockResolvedValue(1);
      emailCount.mockResolvedValue(14);

      await expect(service.deleteUser('admin_1', 'u1')).rejects.toThrow(
        new ConflictException(
          'Suppression refusée : ce compte possède encore 2 domaines, 1 clé API, 14 emails. Suspendez le compte plutôt que de le supprimer.',
        ),
      );
    });

    // --- Cœur du correctif V9-A --------------------------------------

    /**
     * Le scénario exact du porteur : un compte qui n'a fait que confirmer
     * son adresse — un `Email` système et le `CreditEntry` de bienvenue,
     * rien d'autre — doit être supprimable. C'est l'inverse du
     * comportement V8-A, qui comptait ces deux lignes comme des blocages.
     */
    it('deletes an account that has only a system email and the welcome bonus credit entry', async () => {
      // 0 email *client* (system: false), mais le compte a bien un email
      // système qui disparaît une fois la cascade passée.
      mockEmailCounts(0, 0);
      // 0 mouvement *hors* bonus de bienvenue, et le bonus lui-même
      // disparaît une fois la cascade passée.
      mockCreditEntryCounts(0, 0);

      const result = await service.deleteUser('admin_1', 'u1');

      expect(emailCount).toHaveBeenCalledWith({
        where: { userId: 'u1', system: false },
      });
      expect(creditEntryCount).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          reason: { not: CREDIT_REASON_WELCOME_BONUS },
        },
      });
      expect(emailDeleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', system: true },
      });
      expect(creditEntryDeleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', reason: CREDIT_REASON_WELCOME_BONUS },
      });
      expect(userDelete).toHaveBeenCalledWith({ where: { id: 'u1' } });
      expect(result).toEqual({
        id: 'u1',
        email: 'jean@gmial.com',
        actionId: 'action_1',
      });
    });

    /**
     * Symétrique : dès qu'un email **client** (`system: false`) existe, la
     * suppression reste refusée — c'est la garde qui empêche de supprimer
     * un compte ayant une vraie activité d'envoi.
     */
    it('refuses to delete an account that has a client email (system: false)', async () => {
      mockEmailCounts(1, 0);
      mockCreditEntryCounts(0, 0);

      await expect(service.deleteUser('admin_1', 'u1')).rejects.toThrow(
        new ConflictException(
          'Suppression refusée : ce compte possède encore 1 email. Suspendez le compte plutôt que de le supprimer.',
        ),
      );

      expect(actionCreate).not.toHaveBeenCalled();
      expect(emailDeleteMany).not.toHaveBeenCalled();
      expect(userDelete).not.toHaveBeenCalled();
    });

    /**
     * Filet de sécurité : si, malgré des compteurs de blocage à zéro, des
     * lignes `Email`/`CreditEntry` subsistent après la cascade (signe d'un
     * trou dans `buildDeleteBlockers`), `deleteUser` doit refuser plutôt
     * que de heurter la contrainte `Restrict` Postgres ou, pire, réussir en
     * silence en laissant les lignes derrière lui — impossible ici puisque
     * la transaction échoue avant `user.delete`.
     */
    it('refuses when rows unexpectedly survive the cascade (invariant guard)', async () => {
      // Rien ne bloque en apparence...
      mockEmailCounts(0, 1); // ...mais un email non prévu subsiste après la cascade.
      mockCreditEntryCounts(0, 0);

      await expect(service.deleteUser('admin_1', 'u1')).rejects.toThrow(
        /Invariant violé/,
      );

      expect(userDelete).not.toHaveBeenCalled();
      expect(destroyAllForUser).not.toHaveBeenCalled();
    });
  });
});

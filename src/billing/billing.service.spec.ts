import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TopUpMethod, TopUpStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from './billing.service';
import type { CreateTopUpRequestDto } from './dto/create-topup-request.dto';
import {
  CREDIT_REASON_TOPUP,
  CREDIT_REASON_WELCOME_BONUS,
  DUPLICATE_TRANSACTION_REF_MESSAGE,
  PACK_NOT_FOUND_MESSAGE,
  PACK_NOT_PURCHASABLE_MESSAGE,
} from './billing.constants';
import { CREDIT_REASON_ADMIN_GRANT } from '../admin';
import { CREDIT_REASON_SEND } from '../emails/emails.constants';

/**
 * Reproduit le filtrage de `Prisma.creditEntry.aggregate` sur un ledger en
 * mémoire, pour que les tests de `getBalance` vérifient un vrai calcul par
 * motif plutôt que des valeurs de retour câblées par position d'appel. Un
 * retour à « somme de tous les deltas positifs » ferait donc réellement
 * échouer ces tests, au lieu de passer parce que les mocks tombent dans le
 * bon ordre.
 */
function fakeAggregateOver(
  ledger: Array<{ userId: string; delta: number; reason: string }>,
) {
  return ({
    where,
  }: {
    where: {
      userId: string;
      delta?: { gt?: number; lt?: number };
      reason?: string | { not: string };
    };
  }) => {
    const rows = ledger.filter((row) => {
      if (row.userId !== where.userId) return false;
      if (where.delta?.gt !== undefined && !(row.delta > where.delta.gt)) {
        return false;
      }
      if (where.delta?.lt !== undefined && !(row.delta < where.delta.lt)) {
        return false;
      }
      if (where.reason !== undefined) {
        if (typeof where.reason === 'string') {
          if (row.reason !== where.reason) return false;
        } else if (row.reason === where.reason.not) {
          return false;
        }
      }
      return true;
    });

    if (rows.length === 0) {
      return { _sum: { delta: null } };
    }

    return {
      _sum: { delta: rows.reduce((sum, row) => sum + row.delta, 0) },
    };
  };
}

const CREDIT_ENTRY_SELECT = {
  delta: true,
  reason: true,
  reference: true,
  createdAt: true,
};

const TOPUP_REQUEST_SELECT = {
  id: true,
  packId: true,
  credits: true,
  amountGnf: true,
  method: true,
  phoneNumber: true,
  transactionRef: true,
  status: true,
  rejectionReason: true,
  createdAt: true,
};

function dtoWith(
  overrides: Partial<CreateTopUpRequestDto> = {},
): CreateTopUpRequestDto {
  return {
    packId: 'starter',
    method: TopUpMethod.ORANGE_MONEY,
    phoneNumber: '+224 622 00 11 22',
    transactionRef: 'OM-123456',
    ...overrides,
  };
}

describe('BillingService', () => {
  let service: BillingService;

  const aggregate = jest.fn();
  const findMany = jest.fn();
  const count = jest.fn();
  const findFirst = jest.fn();
  const create = jest.fn();
  const topUpFindMany = jest.fn();

  const prisma = {
    creditEntry: { aggregate, findMany, count },
    topUpRequest: { findFirst, create, findMany: topUpFindMany },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [BillingService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<BillingService>(BillingService);
  });

  describe('getBalance', () => {
    it('sums delta for the balance, TOPUP-only positive deltas for purchased, non-TOPUP positive deltas for gifted, and abs(negative) for consumed', async () => {
      aggregate
        .mockResolvedValueOnce({ _sum: { delta: 15 } }) // total
        .mockResolvedValueOnce({ _sum: { delta: 25 } }) // purchased (delta > 0, reason == TOPUP)
        .mockResolvedValueOnce({ _sum: { delta: 0 } }) // gifted (delta > 0, reason != TOPUP)
        .mockResolvedValueOnce({ _sum: { delta: -10 } }); // consumed (delta < 0)

      const result = await service.getBalance('user_1');

      expect(result).toEqual({
        balance: 15,
        totalPurchased: 25,
        totalGifted: 0,
        totalConsumed: 10,
      });
      expect(aggregate).toHaveBeenNthCalledWith(1, {
        where: { userId: 'user_1' },
        _sum: { delta: true },
      });
      expect(aggregate).toHaveBeenNthCalledWith(2, {
        where: {
          userId: 'user_1',
          delta: { gt: 0 },
          reason: CREDIT_REASON_TOPUP,
        },
        _sum: { delta: true },
      });
      expect(aggregate).toHaveBeenNthCalledWith(3, {
        where: {
          userId: 'user_1',
          delta: { gt: 0 },
          reason: { not: CREDIT_REASON_TOPUP },
        },
        _sum: { delta: true },
      });
      expect(aggregate).toHaveBeenNthCalledWith(4, {
        where: { userId: 'user_1', delta: { lt: 0 } },
        _sum: { delta: true },
      });
    });

    it('treats a client with no credit entries at all as all zeros', async () => {
      aggregate.mockResolvedValue({ _sum: { delta: null } });

      const result = await service.getBalance('user_1');

      expect(result).toEqual({
        balance: 0,
        totalPurchased: 0,
        totalGifted: 0,
        totalConsumed: 0,
      });
    });

    it('counts a lone paid top-up entirely as totalPurchased, nothing as gifted', async () => {
      aggregate.mockImplementation(
        fakeAggregateOver([
          { userId: 'user_1', delta: 500, reason: CREDIT_REASON_TOPUP },
        ]),
      );

      const result = await service.getBalance('user_1');

      expect(result).toEqual({
        balance: 500,
        totalPurchased: 500,
        totalGifted: 0,
        totalConsumed: 0,
      });
    });

    it('reports totalPurchased at 0 and a full 1000-credit balance for an account with only the welcome bonus', async () => {
      aggregate.mockImplementation(
        fakeAggregateOver([
          {
            userId: 'user_1',
            delta: 1000,
            reason: CREDIT_REASON_WELCOME_BONUS,
          },
        ]),
      );

      const result = await service.getBalance('user_1');

      expect(result).toEqual({
        balance: 1000,
        totalPurchased: 0,
        totalGifted: 1000,
        totalConsumed: 0,
      });
    });

    it('counts an admin-granted credit as totalGifted, never as totalPurchased — the allow-list regression this fixes', async () => {
      aggregate.mockImplementation(
        fakeAggregateOver([
          { userId: 'user_1', delta: 2000, reason: CREDIT_REASON_ADMIN_GRANT },
        ]),
      );

      const result = await service.getBalance('user_1');

      expect(result).toEqual({
        balance: 2000,
        totalPurchased: 0,
        totalGifted: 2000,
        totalConsumed: 0,
      });
    });

    it('excludes the welcome bonus from totalPurchased when the ledger has both a welcome bonus and a paid top-up, keeping the balance correct', async () => {
      aggregate.mockImplementation(
        fakeAggregateOver([
          {
            userId: 'user_1',
            delta: 1000,
            reason: CREDIT_REASON_WELCOME_BONUS,
          },
          { userId: 'user_1', delta: 500, reason: CREDIT_REASON_TOPUP },
        ]),
      );

      const result = await service.getBalance('user_1');

      expect(result).toEqual({
        balance: 1500,
        totalPurchased: 500, // uniquement la recharge payée, pas le cadeau
        totalGifted: 1000,
        totalConsumed: 0,
      });
    });

    it('keeps balance === totalPurchased + totalGifted - totalConsumed across a TOPUP, a WELCOME_BONUS, an ADMIN_GRANT and a SEND debit', async () => {
      aggregate.mockImplementation(
        fakeAggregateOver([
          { userId: 'user_1', delta: 500, reason: CREDIT_REASON_TOPUP },
          {
            userId: 'user_1',
            delta: 1000,
            reason: CREDIT_REASON_WELCOME_BONUS,
          },
          { userId: 'user_1', delta: 2000, reason: CREDIT_REASON_ADMIN_GRANT },
          { userId: 'user_1', delta: -300, reason: CREDIT_REASON_SEND },
        ]),
      );

      const result = await service.getBalance('user_1');

      expect(result).toEqual({
        balance: 3200,
        totalPurchased: 500,
        totalGifted: 3000,
        totalConsumed: 300,
      });
      expect(result.balance).toBe(
        result.totalPurchased + result.totalGifted - result.totalConsumed,
      );
    });
  });

  describe('listEntries', () => {
    it('applies default pagination (page 1, limit 25) scoped to the current user, newest first', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      const result = await service.listEntries('user_1', {});

      expect(findMany).toHaveBeenCalledWith({
        where: { userId: 'user_1' },
        select: CREDIT_ENTRY_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 25,
      });
      expect(count).toHaveBeenCalledWith({ where: { userId: 'user_1' } });
      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        limit: 25,
        totalPages: 0,
      });
    });

    it('computes skip/take and totalPages for a given page/limit', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(42);

      const result = await service.listEntries('user_1', {
        page: '3',
        limit: '10',
      });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
      expect(result).toMatchObject({ page: 3, limit: 10, totalPages: 5 });
    });

    it('rejects a limit above the max of 100', async () => {
      await expect(
        service.listEntries('user_1', { limit: '101' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('rejects a non-integer page', async () => {
      await expect(
        service.listEntries('user_1', { page: 'abc' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('listPacks', () => {
    it('returns the hard-coded catalogue, decouverte non purchasable', () => {
      const packs = service.listPacks();

      const decouverte = packs.find((pack) => pack.id === 'decouverte');
      const starter = packs.find((pack) => pack.id === 'starter');

      expect(decouverte).toMatchObject({ purchasable: false, credits: 1_000 });
      expect(starter).toMatchObject({
        purchasable: true,
        credits: 10_000,
        amountGnf: 25_000,
      });
    });
  });

  describe('createTopUpRequest', () => {
    it('rejects an unknown pack with a 400', async () => {
      await expect(
        service.createTopUpRequest('user_1', dtoWith({ packId: 'ghost' })),
      ).rejects.toThrow(new BadRequestException(PACK_NOT_FOUND_MESSAGE));

      expect(create).not.toHaveBeenCalled();
    });

    it('rejects a non-purchasable pack with a 400', async () => {
      await expect(
        service.createTopUpRequest('user_1', dtoWith({ packId: 'decouverte' })),
      ).rejects.toThrow(new BadRequestException(PACK_NOT_PURCHASABLE_MESSAGE));

      expect(create).not.toHaveBeenCalled();
    });

    it('rejects a phone number with letters or an invalid digit count', async () => {
      await expect(
        service.createTopUpRequest(
          'user_1',
          dtoWith({ phoneNumber: '622-abc-1122' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.createTopUpRequest('user_1', dtoWith({ phoneNumber: '12345' })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(create).not.toHaveBeenCalled();
    });

    it('refuses a duplicate PENDING transactionRef for the same user with a 409', async () => {
      findFirst.mockResolvedValue({ id: 'topup_existing' });

      await expect(
        service.createTopUpRequest('user_1', dtoWith()),
      ).rejects.toThrow(
        new ConflictException(DUPLICATE_TRANSACTION_REF_MESSAGE),
      );

      expect(findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'user_1',
          transactionRef: 'OM-123456',
          status: TopUpStatus.PENDING,
        },
        select: { id: true },
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('takes credits/amountGnf from the server-side pack, never from the body', async () => {
      findFirst.mockResolvedValue(null);
      create.mockResolvedValue({ id: 'topup_1' });

      // Le body tente de mentir sur credits/amountGnf : ce ne sont même pas
      // des champs du DTO, donc impossibles à faire passer par la requête.
      await service.createTopUpRequest('user_1', dtoWith({ packId: 'growth' }));

      expect(create).toHaveBeenCalledWith({
        data: {
          userId: 'user_1',
          packId: 'growth',
          credits: 30_000,
          amountGnf: 60_000,
          method: TopUpMethod.ORANGE_MONEY,
          phoneNumber: '+224 622 00 11 22',
          transactionRef: 'OM-123456',
        },
        select: TOPUP_REQUEST_SELECT,
      });
    });
  });

  describe('listTopUpRequests', () => {
    it('returns the current user requests, newest first', async () => {
      topUpFindMany.mockResolvedValue([]);

      await service.listTopUpRequests('user_1');

      expect(topUpFindMany).toHaveBeenCalledWith({
        where: { userId: 'user_1' },
        select: TOPUP_REQUEST_SELECT,
        orderBy: { createdAt: 'desc' },
      });
    });
  });
});

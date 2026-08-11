import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminActionType, TopUpMethod, TopUpStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CREDIT_REASON_TOPUP,
  TOPUP_REQUEST_ALREADY_REVIEWED_MESSAGE,
  TOPUP_REQUEST_NOT_FOUND_MESSAGE,
} from '../billing.constants';
import { AdminBillingService } from './admin-billing.service';
import type { RejectTopUpRequestDto } from './dto/reject-topup-request.dto';

const PENDING_REQUEST = {
  id: 'topup_1',
  userId: 'user_1',
  packId: 'starter',
  credits: 10_000,
  amountGnf: 25_000,
  method: TopUpMethod.ORANGE_MONEY,
  phoneNumber: '+224 622 00 11 22',
  transactionRef: 'OM-123456',
  status: TopUpStatus.PENDING,
  reviewedAt: null,
  reviewedBy: null,
  rejectionReason: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

interface UpdateTopUpArgs {
  where: { id: string };
  data: {
    status: TopUpStatus;
    reviewedAt: Date;
    reviewedBy: string;
    rejectionReason?: string;
  };
  select: Record<string, boolean>;
}

describe('AdminBillingService', () => {
  let service: AdminBillingService;
  let capturedUpdate: UpdateTopUpArgs | undefined;

  const findManyTopUp = jest.fn();
  const findUniqueTopUp = jest.fn();
  const updateTopUp = jest.fn();
  const createCreditEntry = jest.fn();
  const createAdminAction = jest.fn();
  const $transaction = jest.fn();

  const prisma = {
    topUpRequest: {
      findMany: findManyTopUp,
      findUnique: findUniqueTopUp,
      update: updateTopUp,
    },
    creditEntry: { create: createCreditEntry },
    adminAction: { create: createAdminAction },
    $transaction,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedUpdate = undefined;
    $transaction.mockImplementation(
      (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminBillingService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AdminBillingService>(AdminBillingService);
  });

  describe('listTopUpRequests', () => {
    it('defaults to PENDING when no status is given', async () => {
      findManyTopUp.mockResolvedValue([]);

      await service.listTopUpRequests({});

      expect(findManyTopUp).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: TopUpStatus.PENDING } }),
      );
    });

    it('filters by the requested status', async () => {
      findManyTopUp.mockResolvedValue([]);

      await service.listTopUpRequests({ status: 'REJECTED' });

      expect(findManyTopUp).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: TopUpStatus.REJECTED } }),
      );
    });
  });

  describe('approve', () => {
    it('moves the request to APPROVED and credits the account in the same transaction', async () => {
      findUniqueTopUp.mockResolvedValue(PENDING_REQUEST);
      updateTopUp.mockImplementation((args: UpdateTopUpArgs) => {
        capturedUpdate = args;
        return Promise.resolve({
          id: 'topup_1',
          status: TopUpStatus.APPROVED,
          userId: 'user_1',
          credits: 10_000,
        });
      });

      const result = await service.approve('topup_1', 'admin_1');

      expect($transaction).toHaveBeenCalledTimes(1);
      const update = capturedUpdate!;
      expect(update.where).toEqual({ id: 'topup_1' });
      expect(update.data.status).toBe(TopUpStatus.APPROVED);
      expect(update.data.reviewedBy).toBe('admin_1');
      expect(update.data.reviewedAt).toBeInstanceOf(Date);
      expect(update.select).toEqual({
        id: true,
        status: true,
        userId: true,
        credits: true,
      });
      expect(createCreditEntry).toHaveBeenCalledWith({
        data: {
          userId: 'user_1',
          delta: 10_000,
          reason: CREDIT_REASON_TOPUP,
          reference: 'topup_1',
        },
      });
      expect(result).toEqual({ id: 'topup_1', status: TopUpStatus.APPROVED });
    });

    it('writes the audit trail inside the same transaction as the credit', async () => {
      findUniqueTopUp.mockResolvedValue(PENDING_REQUEST);
      updateTopUp.mockResolvedValue({
        id: 'topup_1',
        status: TopUpStatus.APPROVED,
        userId: 'user_1',
        credits: 10_000,
      });

      await service.approve('topup_1', 'admin_1');

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(createAdminAction).toHaveBeenCalledWith({
        data: {
          adminId: 'admin_1',
          targetUserId: 'user_1',
          type: AdminActionType.APPROVE_TOPUP,
          details: {
            topUpRequestId: 'topup_1',
            credits: 10_000,
            amountGnf: 25_000,
          },
        },
      });
    });

    it('writes no audit line when the request is already reviewed', async () => {
      findUniqueTopUp.mockResolvedValue({
        ...PENDING_REQUEST,
        status: TopUpStatus.APPROVED,
      });

      await expect(
        service.approve('topup_1', 'admin_1'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(createAdminAction).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown request', async () => {
      findUniqueTopUp.mockResolvedValue(null);

      await expect(service.approve('ghost', 'admin_1')).rejects.toThrow(
        new NotFoundException(TOPUP_REQUEST_NOT_FOUND_MESSAGE),
      );

      expect(updateTopUp).not.toHaveBeenCalled();
      expect(createCreditEntry).not.toHaveBeenCalled();
    });

    it('is idempotent: approving an already-APPROVED request throws 409 without a second credit', async () => {
      findUniqueTopUp.mockResolvedValue({
        ...PENDING_REQUEST,
        status: TopUpStatus.APPROVED,
      });

      await expect(service.approve('topup_1', 'admin_1')).rejects.toThrow(
        new ConflictException(TOPUP_REQUEST_ALREADY_REVIEWED_MESSAGE),
      );

      expect(updateTopUp).not.toHaveBeenCalled();
      expect(createCreditEntry).not.toHaveBeenCalled();
    });

    it('refuses to re-approve an already-REJECTED request with a 409', async () => {
      findUniqueTopUp.mockResolvedValue({
        ...PENDING_REQUEST,
        status: TopUpStatus.REJECTED,
      });

      await expect(
        service.approve('topup_1', 'admin_1'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(createCreditEntry).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    const rejectDto: RejectTopUpRequestDto = {
      reason: 'Référence introuvable côté opérateur',
    };

    it('moves the request to REJECTED with the reason and never credits the account', async () => {
      findUniqueTopUp.mockResolvedValue(PENDING_REQUEST);
      updateTopUp.mockImplementation((args: UpdateTopUpArgs) => {
        capturedUpdate = args;
        return Promise.resolve({
          id: 'topup_1',
          status: TopUpStatus.REJECTED,
        });
      });

      const result = await service.reject('topup_1', 'admin_1', rejectDto);

      const update = capturedUpdate!;
      expect(update.where).toEqual({ id: 'topup_1' });
      expect(update.data.status).toBe(TopUpStatus.REJECTED);
      expect(update.data.reviewedBy).toBe('admin_1');
      expect(update.data.rejectionReason).toBe(rejectDto.reason);
      expect(update.select).toEqual({ id: true, status: true });
      expect(createCreditEntry).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'topup_1', status: TopUpStatus.REJECTED });
    });

    it('writes the audit trail inside the same transaction as the rejection', async () => {
      findUniqueTopUp.mockResolvedValue(PENDING_REQUEST);
      updateTopUp.mockResolvedValue({
        id: 'topup_1',
        status: TopUpStatus.REJECTED,
      });

      await service.reject('topup_1', 'admin_1', rejectDto);

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(createAdminAction).toHaveBeenCalledWith({
        data: {
          adminId: 'admin_1',
          targetUserId: 'user_1',
          type: AdminActionType.REJECT_TOPUP,
          reason: rejectDto.reason,
          details: {
            topUpRequestId: 'topup_1',
            credits: 10_000,
            amountGnf: 25_000,
          },
        },
      });
    });

    it('throws 404 for an unknown request', async () => {
      findUniqueTopUp.mockResolvedValue(null);

      await expect(
        service.reject('ghost', 'admin_1', rejectDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws 409 when the request was already reviewed', async () => {
      findUniqueTopUp.mockResolvedValue({
        ...PENDING_REQUEST,
        status: TopUpStatus.APPROVED,
      });

      await expect(
        service.reject('topup_1', 'admin_1', rejectDto),
      ).rejects.toThrow(
        new ConflictException(TOPUP_REQUEST_ALREADY_REVIEWED_MESSAGE),
      );

      expect(updateTopUp).not.toHaveBeenCalled();
    });
  });
});

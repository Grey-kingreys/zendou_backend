import { Test, TestingModule } from '@nestjs/testing';
import { TopUpMethod, TopUpStatus, UserRole, UserStatus } from '@prisma/client';
import { SessionAuthGuard } from '../auth';
import type { AuthUser } from '../auth';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import type { CreateTopUpRequestDto } from './dto/create-topup-request.dto';

const authUser: AuthUser = {
  id: 'user_1',
  email: 'aissatou@example.com',
  name: 'Aïssatou Diallo',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('BillingController', () => {
  let controller: BillingController;

  const billingService = {
    getBalance: jest.fn(),
    listEntries: jest.fn(),
    listPacks: jest.fn(),
    createTopUpRequest: jest.fn(),
    listTopUpRequests: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [{ provide: BillingService, useValue: billingService }],
    })
      // Le guard est couvert par session-auth.guard.spec.ts.
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<BillingController>(BillingController);
  });

  it('delegates the balance lookup to the service, scoped to the current user', async () => {
    billingService.getBalance.mockResolvedValue({
      balance: 100,
      totalPurchased: 100,
      totalConsumed: 0,
    });

    const result = await controller.getBalance(authUser);

    expect(billingService.getBalance).toHaveBeenCalledWith('user_1');
    expect(result).toEqual({
      balance: 100,
      totalPurchased: 100,
      totalConsumed: 0,
    });
  });

  it('delegates the ledger listing to the service', async () => {
    const paginated = {
      items: [],
      total: 0,
      page: 1,
      limit: 25,
      totalPages: 0,
    };
    billingService.listEntries.mockResolvedValue(paginated);

    const result = await controller.listEntries({ page: '2' }, authUser);

    expect(billingService.listEntries).toHaveBeenCalledWith('user_1', {
      page: '2',
    });
    expect(result).toEqual(paginated);
  });

  it('returns the pack catalogue from the service', () => {
    billingService.listPacks.mockReturnValue([]);

    expect(controller.listPacks()).toEqual([]);
    expect(billingService.listPacks).toHaveBeenCalled();
  });

  it('delegates top-up request creation to the service, scoped to the current user', async () => {
    const dto: CreateTopUpRequestDto = {
      packId: 'starter',
      method: TopUpMethod.ORANGE_MONEY,
      phoneNumber: '+224 622 00 11 22',
      transactionRef: 'OM-123456',
    };
    const created = {
      id: 'topup_1',
      packId: 'starter',
      credits: 10_000,
      amountGnf: 25_000,
      method: TopUpMethod.ORANGE_MONEY,
      phoneNumber: '+224 622 00 11 22',
      transactionRef: 'OM-123456',
      status: TopUpStatus.PENDING,
      rejectionReason: null,
      createdAt: new Date('2026-08-11T00:00:00.000Z'),
    };
    billingService.createTopUpRequest.mockResolvedValue(created);

    const result = await controller.createTopUpRequest(dto, authUser);

    expect(billingService.createTopUpRequest).toHaveBeenCalledWith(
      'user_1',
      dto,
    );
    expect(result).toEqual(created);
  });

  it('delegates the list of the current user top-up requests to the service', async () => {
    billingService.listTopUpRequests.mockResolvedValue([]);

    const result = await controller.listTopUpRequests(authUser);

    expect(billingService.listTopUpRequests).toHaveBeenCalledWith('user_1');
    expect(result).toEqual([]);
  });
});

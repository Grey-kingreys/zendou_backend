import { Test, TestingModule } from '@nestjs/testing';
import { TopUpStatus, UserRole, UserStatus } from '@prisma/client';
import type { AuthUser } from '../../auth';
import { AdminBillingController } from './admin-billing.controller';
import { AdminBillingService } from './admin-billing.service';
import { AdminGuard } from './admin.guard';
import type { RejectTopUpRequestDto } from './dto/reject-topup-request.dto';

const adminUser: AuthUser = {
  id: 'admin_1',
  email: 'admin@zendou.gn',
  name: 'Admin Zendou',
  company: null,
  declaredUsage: null,
  role: UserRole.ADMIN,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('AdminBillingController', () => {
  let controller: AdminBillingController;

  const adminBillingService = {
    listTopUpRequests: jest.fn(),
    approve: jest.fn(),
    reject: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminBillingController],
      providers: [
        { provide: AdminBillingService, useValue: adminBillingService },
      ],
    })
      // Le guard est couvert par admin.guard.spec.ts.
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AdminBillingController>(AdminBillingController);
  });

  it('delegates the list to the service with the raw query', async () => {
    adminBillingService.listTopUpRequests.mockResolvedValue([]);

    const result = await controller.list({ status: 'REJECTED' });

    expect(adminBillingService.listTopUpRequests).toHaveBeenCalledWith({
      status: 'REJECTED',
    });
    expect(result).toEqual([]);
  });

  it('delegates approve to the service with the reviewing admin id', async () => {
    adminBillingService.approve.mockResolvedValue({
      id: 'topup_1',
      status: TopUpStatus.APPROVED,
    });

    const result = await controller.approve('topup_1', adminUser);

    expect(adminBillingService.approve).toHaveBeenCalledWith(
      'topup_1',
      'admin_1',
    );
    expect(result).toEqual({ id: 'topup_1', status: TopUpStatus.APPROVED });
  });

  it('delegates reject to the service with the reviewing admin id and the reason', async () => {
    const dto: RejectTopUpRequestDto = { reason: 'Référence invalide' };
    adminBillingService.reject.mockResolvedValue({
      id: 'topup_1',
      status: TopUpStatus.REJECTED,
    });

    const result = await controller.reject('topup_1', dto, adminUser);

    expect(adminBillingService.reject).toHaveBeenCalledWith(
      'topup_1',
      'admin_1',
      dto,
    );
    expect(result).toEqual({ id: 'topup_1', status: TopUpStatus.REJECTED });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import type { AuthUser } from '../auth';
import { AdminGuard } from '../billing/admin/admin.guard';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

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

describe('AdminUsersController', () => {
  let controller: AdminUsersController;

  const adminUsersService = {
    list: jest.fn(),
    detail: jest.fn(),
    suspend: jest.fn(),
    reactivate: jest.fn(),
    updateQuota: jest.fn(),
    grantCredits: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminUsersController],
      providers: [{ provide: AdminUsersService, useValue: adminUsersService }],
    })
      // Le garde est couvert par billing/admin/admin.guard.spec.ts —
      // le contrôleur réutilise le même, il n'en existe pas un second.
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AdminUsersController>(AdminUsersController);
  });

  it('passes the raw query through to the service', async () => {
    adminUsersService.list.mockResolvedValue({ items: [] });

    await controller.list({ page: '2', q: 'awa' });

    expect(adminUsersService.list).toHaveBeenCalledWith({
      page: '2',
      q: 'awa',
    });
  });

  it('delegates the detail lookup', async () => {
    adminUsersService.detail.mockResolvedValue({ id: 'u1' });

    await controller.detail('u1');

    expect(adminUsersService.detail).toHaveBeenCalledWith('u1');
  });

  /** L'admin qui agit vient toujours de la session, jamais du corps. */
  it('suspends with the acting admin taken from the session', async () => {
    adminUsersService.suspend.mockResolvedValue({ id: 'u1' });
    const dto = { reason: 'Envois non sollicités' };

    await controller.suspend('u1', dto, adminUser);

    expect(adminUsersService.suspend).toHaveBeenCalledWith(
      'admin_1',
      'u1',
      dto,
    );
  });

  it('reactivates with the acting admin taken from the session', async () => {
    adminUsersService.reactivate.mockResolvedValue({ id: 'u1' });
    const dto = { reason: 'Liste nettoyée' };

    await controller.reactivate('u1', dto, adminUser);

    expect(adminUsersService.reactivate).toHaveBeenCalledWith(
      'admin_1',
      'u1',
      dto,
    );
  });

  it('adjusts the quota with the acting admin taken from the session', async () => {
    adminUsersService.updateQuota.mockResolvedValue({ id: 'u1' });
    const dto = { dailySendLimit: 5_000 };

    await controller.quota('u1', dto, adminUser);

    expect(adminUsersService.updateQuota).toHaveBeenCalledWith(
      'admin_1',
      'u1',
      dto,
    );
  });

  it('grants credits with the acting admin taken from the session', async () => {
    adminUsersService.grantCredits.mockResolvedValue({ id: 'u1' });
    const dto = { delta: -500, reason: 'Avoir repris' };

    await controller.credits('u1', dto, adminUser);

    expect(adminUsersService.grantCredits).toHaveBeenCalledWith(
      'admin_1',
      'u1',
      dto,
    );
  });
});

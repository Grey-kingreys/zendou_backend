import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import { AuthUser, SessionAuthGuard } from '../auth';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';

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

describe('ApiKeysController', () => {
  let controller: ApiKeysController;

  const apiKeysService = {
    create: jest.fn(),
    findAllForUser: jest.fn(),
    revoke: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApiKeysController],
      providers: [{ provide: ApiKeysService, useValue: apiKeysService }],
    })
      // Le guard est couvert par session-auth.guard.spec.ts.
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ApiKeysController>(ApiKeysController);
  });

  it('scopes creation to the current user', async () => {
    apiKeysService.create.mockResolvedValue({
      id: 'key_1',
      name: 'Prod',
      prefix: 'zd_live_abcd',
      key: 'zd_live_abcd1234',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await controller.create(authUser, { name: 'Prod' });

    expect(apiKeysService.create).toHaveBeenCalledWith('user_1', {
      name: 'Prod',
    });
  });

  it('scopes the list to the current user', async () => {
    apiKeysService.findAllForUser.mockResolvedValue([]);

    await controller.findAll(authUser);

    expect(apiKeysService.findAllForUser).toHaveBeenCalledWith('user_1');
  });

  it('scopes revocation to the current user', async () => {
    apiKeysService.revoke.mockResolvedValue(undefined);

    await controller.revoke(authUser, 'key_1');

    expect(apiKeysService.revoke).toHaveBeenCalledWith('user_1', 'key_1');
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import type { ApiKeyAuthenticatedRequest } from '../api-keys';
import type { AuthUser } from '../auth';
import { SessionOrApiKeyGuard } from '../common/session-or-api-key.guard';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';

const user: AuthUser = {
  id: 'user_1',
  email: 'amadou@example.com',
  name: 'Amadou Barry',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

/** Requête d'une session : aucune clé API. */
const noKey = {} as ApiKeyAuthenticatedRequest;

describe('DomainsController', () => {
  let controller: DomainsController;

  const domainsService = {
    create: jest.fn(),
    list: jest.fn(),
    findOne: jest.fn(),
    check: jest.fn(),
    dnsCheck: jest.fn(),
    remove: jest.fn(),
    usage: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DomainsController],
      providers: [{ provide: DomainsService, useValue: domainsService }],
    })
      .overrideGuard(SessionOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DomainsController>(DomainsController);
  });

  it('protects every route with the session-or-api-key guard', () => {
    const guards: unknown = Reflect.getMetadata(
      '__guards__',
      DomainsController,
    );

    expect(guards).toEqual([SessionOrApiKeyGuard]);
  });

  it('scopes every handler to the authenticated user', async () => {
    await controller.create(user, { name: 'boutique-awa.gn' });
    await controller.list(user, noKey);
    await controller.findOne(user, 'dom_1', noKey);
    await controller.check(user, 'dom_1');
    await controller.dnsCheck(user, 'dom_1');
    await controller.usage(user, 'dom_1');
    await controller.remove(user, 'dom_1');

    expect(domainsService.usage).toHaveBeenCalledWith('user_1', 'dom_1');
    expect(domainsService.create).toHaveBeenCalledWith(
      'user_1',
      'boutique-awa.gn',
    );
    expect(domainsService.list).toHaveBeenCalledWith('user_1', undefined);
    expect(domainsService.findOne).toHaveBeenCalledWith(
      'user_1',
      'dom_1',
      undefined,
    );
    expect(domainsService.check).toHaveBeenCalledWith('user_1', 'dom_1');
    expect(domainsService.dnsCheck).toHaveBeenCalledWith('user_1', 'dom_1');
    expect(domainsService.remove).toHaveBeenCalledWith('user_1', 'dom_1');
  });
});

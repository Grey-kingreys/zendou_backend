import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import { SessionAuthGuard } from '../auth';
import type { AuthUser } from '../auth';
import { ReputationController } from './reputation.controller';
import { ReputationService } from './reputation.service';
import type { ReputationOverview } from './reputation.types';

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

describe('ReputationController', () => {
  let controller: ReputationController;

  const reputationService = { overview: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReputationController],
      providers: [{ provide: ReputationService, useValue: reputationService }],
    })
      // Le guard est couvert par session-auth.guard.spec.ts.
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(ReputationController);
  });

  it('serves the reputation of the current user only', async () => {
    const overview: ReputationOverview = {
      sent: 120,
      bounces: 3,
      hardBounces: 3,
      transientBounces: 0,
      complaints: 0,
      bounceRate: 0.025,
      complaintRate: 0,
      verdict: 'OK',
      dailySendLimit: 1_000,
      status: UserStatus.ACTIVE,
    };
    reputationService.overview.mockResolvedValue(overview);

    await expect(controller.overview(authUser)).resolves.toEqual(overview);

    expect(reputationService.overview).toHaveBeenCalledWith('user_1');
  });
});

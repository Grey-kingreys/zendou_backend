import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import type { AuthenticatedRequest, AuthUser } from '../../auth';
import { SessionAuthGuard } from '../../auth';
import { AdminGuard } from './admin.guard';

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

const customerUser: AuthUser = {
  ...adminUser,
  id: 'user_1',
  email: 'aissatou@example.com',
  role: UserRole.CUSTOMER,
};

function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  let guard: AdminGuard;

  // SessionAuthGuard lui-même est couvert par session-auth.guard.spec.ts :
  // ici on ne teste que la composition (délégation + contrôle du rôle).
  const sessionAuthGuard = { canActivate: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new AdminGuard(sessionAuthGuard as unknown as SessionAuthGuard);
  });

  it('lets an authenticated ADMIN through', async () => {
    sessionAuthGuard.canActivate.mockResolvedValue(true);
    const request: Partial<AuthenticatedRequest> = { user: adminUser };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(sessionAuthGuard.canActivate).toHaveBeenCalled();
  });

  it('throws 403 for an authenticated CUSTOMER', async () => {
    sessionAuthGuard.canActivate.mockResolvedValue(true);
    const request: Partial<AuthenticatedRequest> = { user: customerUser };

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('propagates the exception SessionAuthGuard throws when unauthenticated', async () => {
    const unauthorized = new Error('401');
    sessionAuthGuard.canActivate.mockRejectedValue(unauthorized);

    await expect(guard.canActivate(contextFor({}))).rejects.toBe(unauthorized);
  });
});

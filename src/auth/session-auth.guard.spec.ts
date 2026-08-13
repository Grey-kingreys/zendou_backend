import { Test, TestingModule } from '@nestjs/testing';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_COOKIE_NAME } from './auth.constants';
import { AuthenticatedRequest, AuthUser } from './auth.types';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';

const activeUser: AuthUser = {
  id: 'user_1',
  email: 'aissatou@example.com',
  name: 'Aïssatou Diallo',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  // TEST_EMAIL_FROM non configurée par défaut dans ces tests (voir le mock
  // de ConfigService ci-dessous) : `resolveTestSenderAddress` renvoie `null`.
  testSenderAddress: null,
};

function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('SessionAuthGuard', () => {
  let guard: SessionAuthGuard;

  const findUnique = jest.fn();
  const sessionService = {
    create: jest.fn(),
    resolve: jest.fn(),
    destroy: jest.fn(),
  };
  const configGet = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    configGet.mockReturnValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionAuthGuard,
        { provide: SessionService, useValue: sessionService },
        { provide: PrismaService, useValue: { user: { findUnique } } },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    guard = module.get<SessionAuthGuard>(SessionAuthGuard);
  });

  it('throws 401 when no session cookie is present', async () => {
    await expect(
      guard.canActivate(contextFor({ cookies: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(sessionService.resolve).not.toHaveBeenCalled();
  });

  it('throws 401 when the cookie jar itself is missing', async () => {
    await expect(guard.canActivate(contextFor({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws 401 when the session is unknown or expired', async () => {
    sessionService.resolve.mockResolvedValue(null);

    await expect(
      guard.canActivate(
        contextFor({ cookies: { [SESSION_COOKIE_NAME]: 'tok' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(findUnique).not.toHaveBeenCalled();
  });

  it('injects the current user on the request for a valid session', async () => {
    sessionService.resolve.mockResolvedValue('user_1');
    findUnique.mockResolvedValue(activeUser);

    const request: Partial<AuthenticatedRequest> = {
      cookies: { [SESSION_COOKIE_NAME]: 'tok' },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(sessionService.resolve).toHaveBeenCalledWith('tok');
    expect(request.user).toEqual(activeUser);
    expect(request.sessionToken).toBe('tok');
  });

  it('attaches the sandbox sender address (bare form) when TEST_EMAIL_FROM is configured', async () => {
    configGet.mockReturnValue('Zendou Test <test@mail.kingreys.fr>');
    sessionService.resolve.mockResolvedValue('user_1');
    findUnique.mockResolvedValue(activeUser);

    const request: Partial<AuthenticatedRequest> = {
      cookies: { [SESSION_COOKIE_NAME]: 'tok' },
    };

    await guard.canActivate(contextFor(request));

    expect(request.user).toHaveProperty(
      'testSenderAddress',
      'test@mail.kingreys.fr',
    );
  });

  it('reports null when TEST_EMAIL_FROM is absent', async () => {
    configGet.mockReturnValue(undefined);
    sessionService.resolve.mockResolvedValue('user_1');
    findUnique.mockResolvedValue(activeUser);

    const request: Partial<AuthenticatedRequest> = {
      cookies: { [SESSION_COOKIE_NAME]: 'tok' },
    };

    await guard.canActivate(contextFor(request));

    expect(request.user).toHaveProperty('testSenderAddress', null);
  });

  it('throws 403 when the account is suspended', async () => {
    sessionService.resolve.mockResolvedValue('user_1');
    findUnique.mockResolvedValue({
      ...activeUser,
      status: UserStatus.SUSPENDED,
    });

    const request: Partial<AuthenticatedRequest> = {
      cookies: { [SESSION_COOKIE_NAME]: 'tok' },
    };

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(request.user).toBeUndefined();
  });

  it('drops an orphan session when the user no longer exists', async () => {
    sessionService.resolve.mockResolvedValue('user_ghost');
    findUnique.mockResolvedValue(null);

    await expect(
      guard.canActivate(
        contextFor({ cookies: { [SESSION_COOKIE_NAME]: 'tok' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(sessionService.destroy).toHaveBeenCalledWith('tok');
  });
});

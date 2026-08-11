import { Test, TestingModule } from '@nestjs/testing';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { hashApiKey } from './api-key.utils';
import { ApiKeyAuthenticatedRequest } from './api-keys.types';

interface UpdateArgs {
  where: { id: string };
  data: { lastUsedAt: Date };
}

const activeUser: AuthUser = {
  id: 'user_1',
  email: 'aissatou@example.com',
  name: 'Aïssatou Diallo',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function contextFor(
  request: Partial<ApiKeyAuthenticatedRequest>,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const validKey = 'zd_live_' + 'a'.repeat(40);

describe('ApiKeyAuthGuard', () => {
  let guard: ApiKeyAuthGuard;
  let capturedUpdateArgs: UpdateArgs | undefined;
  let resolveUpdate: (() => void) | undefined;

  const findUnique = jest.fn();
  const update = jest.fn((args: UpdateArgs) => {
    capturedUpdateArgs = args;
    // Résolue immédiatement par défaut ; certains tests reprennent le
    // contrôle via `resolveUpdate` pour vérifier le comportement non bloquant.
    return new Promise<void>((resolve) => {
      resolveUpdate = resolve;
      resolve();
    });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedUpdateArgs = undefined;
    resolveUpdate = undefined;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyAuthGuard,
        {
          provide: PrismaService,
          useValue: { apiKey: { findUnique, update } },
        },
      ],
    }).compile();

    guard = module.get<ApiKeyAuthGuard>(ApiKeyAuthGuard);
  });

  it('throws 401 when the Authorization header is missing', async () => {
    await expect(
      guard.canActivate(contextFor({ headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(findUnique).not.toHaveBeenCalled();
  });

  it('throws 401 when the scheme is not Bearer', async () => {
    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: `Basic ${validKey}` } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 401 for an unknown key', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: `Bearer ${validKey}` } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { keyHash: hashApiKey(validKey) } }),
    );
  });

  it('throws 401 for a revoked key', async () => {
    findUnique.mockResolvedValue({
      id: 'key_1',
      revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      user: activeUser,
    });

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: `Bearer ${validKey}` } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(update).not.toHaveBeenCalled();
  });

  it('throws 403 when the owning user is suspended', async () => {
    findUnique.mockResolvedValue({
      id: 'key_1',
      revokedAt: null,
      user: { ...activeUser, status: UserStatus.SUSPENDED },
    });

    const request: Partial<ApiKeyAuthenticatedRequest> = {
      headers: { authorization: `Bearer ${validKey}` },
    };

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(request.user).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('attaches user and apiKeyId to the request for a valid key', async () => {
    findUnique.mockResolvedValue({
      id: 'key_1',
      revokedAt: null,
      user: activeUser,
    });

    const request: Partial<ApiKeyAuthenticatedRequest> = {
      headers: { authorization: `Bearer ${validKey}` },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(request.user).toEqual(activeUser);
    expect(request.apiKeyId).toBe('key_1');
  });

  it('updates lastUsedAt in the background without blocking canActivate', async () => {
    findUnique.mockResolvedValue({
      id: 'key_1',
      revokedAt: null,
      user: activeUser,
    });

    // La mise à jour ne se résout jamais pendant le test : canActivate ne
    // doit pas l'attendre pour renvoyer `true`.
    update.mockImplementationOnce((args: UpdateArgs) => {
      capturedUpdateArgs = args;
      return new Promise<void>((resolve) => {
        resolveUpdate = resolve;
      });
    });

    const request: Partial<ApiKeyAuthenticatedRequest> = {
      headers: { authorization: `Bearer ${validKey}` },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(capturedUpdateArgs).toBeDefined();
    expect(capturedUpdateArgs!.where).toEqual({ id: 'key_1' });
    expect(capturedUpdateArgs!.data.lastUsedAt).toBeInstanceOf(Date);

    resolveUpdate?.();
  });
});

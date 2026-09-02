import { createHash, createHmac } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth';
import { TOO_MANY_REQUESTS_MESSAGE } from '../rate-limit/rate-limit.constants';
import { RedisThrottlerStorage } from '../rate-limit/redis-throttler.storage';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { hashApiKey } from './api-key.utils';
import {
  API_KEY_FAILURE_KEY_PREFIX,
  API_KEY_FAILURES_PER_MINUTE_DEFAULT,
} from './api-keys.constants';
import { ApiKeyAuthenticatedRequest } from './api-keys.types';
import { SecretHashingService } from './secret-hashing.service';

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
  // TEST_EMAIL_FROM non configurée par défaut dans ces tests (voir le mock
  // de ConfigService ci-dessous) : `resolveTestSenderAddress` renvoie `null`.
  testSenderAddress: null,
};

const responseMock = { setHeader: jest.fn() };

function contextFor(
  request: Partial<ApiKeyAuthenticatedRequest>,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => responseMock,
    }),
  } as unknown as ExecutionContext;
}

const validKey = 'zd_live_' + 'a'.repeat(43);

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
  const configGet = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedUpdateArgs = undefined;
    resolveUpdate = undefined;
    configGet.mockReturnValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyAuthGuard,
        {
          provide: PrismaService,
          useValue: { apiKey: { findUnique, update } },
        },
        { provide: ConfigService, useValue: { get: configGet } },
        SecretHashingService,
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

  it('reports the sandbox sender address when TEST_EMAIL_FROM is configured', async () => {
    configGet.mockReturnValue('Zendou Test <test@mail.kingreys.fr>');
    findUnique.mockResolvedValue({
      id: 'key_1',
      revokedAt: null,
      user: activeUser,
    });

    const request: Partial<ApiKeyAuthenticatedRequest> = {
      headers: { authorization: `Bearer ${validKey}` },
    };

    await guard.canActivate(contextFor(request));

    // Adresse nue, sans le nom d'affichage — voir `resolveTestSenderAddress`.
    expect(request.user).toHaveProperty(
      'testSenderAddress',
      'test@mail.kingreys.fr',
    );
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

/**
 * Lot C - limite par IP des échecs d'authentification par clé API.
 *
 * Le stockage est un double en mémoire qui reproduit la sémantique du script
 * Lua de `RedisThrottlerStorage` : le blocage tombe quand le nombre de coups
 * dépasse la limite (`hits > limit`), et une IP déjà bloquée n'incrémente
 * plus rien.
 */
class FakeThrottlerStorage {
  private hits = new Map<string, number>();
  private blocked = new Set<string>();
  /** Rejette au lieu de compter : simule un magasin Redis en panne. */
  broken = false;

  increment = jest.fn(
    (key: string, ttl: number, limit: number, blockDuration: number) => {
      if (this.broken) {
        return Promise.reject(new Error('Redis injoignable'));
      }

      if (this.blocked.has(key)) {
        return Promise.resolve({
          totalHits: this.hits.get(key) ?? 0,
          timeToExpire: ttl / 1000,
          isBlocked: true,
          timeToBlockExpire: blockDuration / 1000,
        });
      }

      const total = (this.hits.get(key) ?? 0) + 1;
      this.hits.set(key, total);

      if (total > limit) {
        this.blocked.add(key);
        return Promise.resolve({
          totalHits: total,
          timeToExpire: ttl / 1000,
          isBlocked: true,
          timeToBlockExpire: blockDuration / 1000,
        });
      }

      return Promise.resolve({
        totalHits: total,
        timeToExpire: ttl / 1000,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    },
  );
}

describe('ApiKeyAuthGuard - échecs comptés par IP (lot C)', () => {
  let guard: ApiKeyAuthGuard;
  let storage: FakeThrottlerStorage;

  const findUnique = jest.fn();
  const update = jest.fn().mockResolvedValue({});
  const configGet = jest.fn();

  const clientIp = '203.0.113.10';
  const counterKey = `${API_KEY_FAILURE_KEY_PREFIX}${createHash('sha256')
    .update(clientIp)
    .digest('hex')}`;

  function requestWith(authorization?: string) {
    return {
      ip: clientIp,
      headers: authorization ? { authorization } : {},
    } as unknown as Partial<ApiKeyAuthenticatedRequest>;
  }

  /** Une tentative avec une clé inconnue : toujours un échec. */
  function failOnce() {
    return guard.canActivate(
      contextFor(requestWith(`Bearer ${'zd_live_' + 'b'.repeat(43)}`)),
    );
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    configGet.mockReturnValue(undefined);
    findUnique.mockResolvedValue(null);
    storage = new FakeThrottlerStorage();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyAuthGuard,
        {
          provide: PrismaService,
          useValue: { apiKey: { findUnique, update } },
        },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: RedisThrottlerStorage, useValue: storage },
        SecretHashingService,
      ],
    }).compile();

    guard = module.get<ApiKeyAuthGuard>(ApiKeyAuthGuard);
  });

  it('compte sur l’empreinte de l’IP, jamais sur l’IP en clair', async () => {
    await expect(failOnce()).rejects.toBeInstanceOf(UnauthorizedException);

    expect(storage.increment).toHaveBeenCalledWith(
      counterKey,
      60_000,
      API_KEY_FAILURES_PER_MINUTE_DEFAULT,
      60_000,
    );
    expect(counterKey).not.toContain(clientIp);
  });

  it('laisse passer 20 échecs en 401, puis répond 429 au 21e', async () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      await expect(failOnce()).rejects.toBeInstanceOf(UnauthorizedException);
    }

    expect(responseMock.setHeader).not.toHaveBeenCalled();

    const error: unknown = await failOnce().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(exception.getResponse()).toEqual({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: TOO_MANY_REQUESTS_MESSAGE,
      retryAfter: 60,
    });
    expect(responseMock.setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it.each([
    ['header absent', undefined],
    ['schéma non Bearer', `Basic ${validKey}`],
  ])('compte aussi l’échec « %s »', async (_label, authorization) => {
    await expect(
      guard.canActivate(contextFor(requestWith(authorization))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(storage.increment).toHaveBeenCalledTimes(1);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('compte aussi une clé révoquée', async () => {
    findUnique.mockResolvedValue({
      id: 'key_1',
      revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      user: activeUser,
    });

    await expect(
      guard.canActivate(contextFor(requestWith(`Bearer ${validKey}`))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(storage.increment).toHaveBeenCalledTimes(1);
  });

  it('laisse passer une clé valide même quand l’IP est bloquée', async () => {
    for (let attempt = 1; attempt <= 21; attempt++) {
      await expect(failOnce()).rejects.toBeDefined();
    }
    expect(storage.increment).toHaveBeenCalledTimes(21);

    // Même IP, même seconde : la clé, elle, est bonne. Le client légitime
    // derrière le NAT de l'attaquant ne doit pas payer pour lui.
    findUnique.mockResolvedValue({
      id: 'key_1',
      revokedAt: null,
      user: activeUser,
    });

    const request = requestWith(`Bearer ${validKey}`);
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(request.user).toEqual(activeUser);
    // Aucun coup supplémentaire : un succès ne touche jamais le compteur.
    expect(storage.increment).toHaveBeenCalledTimes(21);
  });

  it('rend un 401 normal quand le compteur est en panne', async () => {
    storage.broken = true;

    await expect(failOnce()).rejects.toBeInstanceOf(UnauthorizedException);
    expect(responseMock.setHeader).not.toHaveBeenCalled();
  });

  it('lit la limite depuis RATE_LIMIT_API_KEY_FAILURES_PER_MINUTE', async () => {
    configGet.mockImplementation((key: string) =>
      key === 'RATE_LIMIT_API_KEY_FAILURES_PER_MINUTE' ? 2 : undefined,
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyAuthGuard,
        {
          provide: PrismaService,
          useValue: { apiKey: { findUnique, update } },
        },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: RedisThrottlerStorage, useValue: storage },
        SecretHashingService,
      ],
    }).compile();
    guard = module.get<ApiKeyAuthGuard>(ApiKeyAuthGuard);

    await expect(failOnce()).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(failOnce()).rejects.toBeInstanceOf(UnauthorizedException);

    const error: unknown = await failOnce().catch((thrown: unknown) => thrown);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });
});

/**
 * E3 - poivre HMAC et migration paresseuse des empreintes.
 *
 * Le double de Prisma indexe les lignes par empreinte, comme la vraie colonne
 * unique `keyHash` : c'est donc le vrai code du garde qui décide sous quelle
 * forme chercher, et dans quel ordre.
 */
describe('ApiKeyAuthGuard - poivre et migration paresseuse (E3)', () => {
  const PEPPER = 'p'.repeat(64);
  const plainKey = `zd_live_${'c'.repeat(43)}`;
  const legacyHash = hashApiKey(plainKey);
  const pepperedHash = createHmac('sha256', PEPPER)
    .update(plainKey)
    .digest('hex');

  interface Row {
    id: string;
    keyHash: string;
    revokedAt: Date | null;
  }

  let rows: Row[];
  let guard: ApiKeyAuthGuard;

  const findUnique = jest.fn(({ where }: { where: { keyHash: string } }) => {
    const row = rows.find((candidate) => candidate.keyHash === where.keyHash);
    return Promise.resolve(
      row ? { id: row.id, revokedAt: row.revokedAt, user: activeUser } : null,
    );
  });
  const update = jest.fn(
    ({
      where,
      data,
    }: {
      where: { id: string };
      data: { keyHash?: string; lastUsedAt?: Date };
    }) => {
      if (data.keyHash) {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (row) {
          row.keyHash = data.keyHash;
        }
      }
      return Promise.resolve({});
    },
  );

  /** Appels d'écriture qui touchent réellement l'empreinte. */
  function hashRewrites() {
    return update.mock.calls.filter(
      ([args]: [{ data: { keyHash?: string } }]) =>
        args.data.keyHash !== undefined,
    );
  }

  async function buildGuard(pepper?: string): Promise<ApiKeyAuthGuard> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyAuthGuard,
        {
          provide: PrismaService,
          useValue: { apiKey: { findUnique, update } },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'API_KEY_PEPPER' ? pepper : undefined,
          },
        },
        SecretHashingService,
      ],
    }).compile();

    return module.get<ApiKeyAuthGuard>(ApiKeyAuthGuard);
  }

  function authenticate() {
    const request: Partial<ApiKeyAuthenticatedRequest> = {
      headers: { authorization: `Bearer ${plainKey}` },
    };
    return { request, result: guard.canActivate(contextFor(request)) };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    rows = [];
    guard = await buildGuard(PEPPER);
  });

  it('accepte une clé dont la base porte encore l’empreinte historique, puis la réécrit poivrée', async () => {
    rows.push({ id: 'key_1', keyHash: legacyHash, revokedAt: null });

    const { request, result } = authenticate();
    await expect(result).resolves.toBe(true);
    expect(request.user).toEqual(activeUser);

    // Cherchée poivrée d'abord, historique ensuite.
    expect(findUnique.mock.calls.map(([args]) => args.where.keyHash)).toEqual([
      pepperedHash,
      legacyHash,
    ]);

    // Réécriture effectuée, et sur la bonne ligne.
    expect(hashRewrites()).toHaveLength(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'key_1' },
      data: { keyHash: pepperedHash },
    });
    expect(rows[0].keyHash).toBe(pepperedHash);
  });

  it('n’a plus rien à réécrire au deuxième passage : la clé est déjà migrée', async () => {
    rows.push({ id: 'key_1', keyHash: legacyHash, revokedAt: null });

    await expect(authenticate().result).resolves.toBe(true);
    jest.clearAllMocks();
    await expect(authenticate().result).resolves.toBe(true);

    expect(hashRewrites()).toHaveLength(0);
    // Une seule lecture : la forme poivrée répond du premier coup.
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('accepte une clé déjà poivrée sans jamais réécrire son empreinte', async () => {
    rows.push({ id: 'key_1', keyHash: pepperedHash, revokedAt: null });

    await expect(authenticate().result).resolves.toBe(true);

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(hashRewrites()).toHaveLength(0);
  });

  it('refuse une clé historique révoquée et ne la réécrit pas', async () => {
    rows.push({
      id: 'key_1',
      keyHash: legacyHash,
      revokedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(authenticate().result).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(hashRewrites()).toHaveLength(0);
    expect(rows[0].keyHash).toBe(legacyHash);
  });

  it('laisse passer l’authentification quand la réécriture échoue', async () => {
    rows.push({ id: 'key_1', keyHash: legacyHash, revokedAt: null });
    update.mockRejectedValueOnce(new Error('base en lecture seule'));

    await expect(authenticate().result).resolves.toBe(true);
  });

  it('sans poivre, cherche une seule empreinte et ne migre rien', async () => {
    guard = await buildGuard(undefined);
    rows.push({ id: 'key_1', keyHash: legacyHash, revokedAt: null });

    await expect(authenticate().result).resolves.toBe(true);

    expect(findUnique.mock.calls.map(([args]) => args.where.keyHash)).toEqual([
      legacyHash,
    ]);
    expect(hashRewrites()).toHaveLength(0);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyAuthenticatedRequest } from './api-keys.types';

/**
 * Ligne stockée par le double de `PrismaService.apiKey` ci-dessous.
 */
interface Row {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  keyHash: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  rotatedAt: Date | null;
  createdAt: Date;
}

const owner: AuthUser = {
  id: 'user_1',
  email: 'aissatou@example.com',
  name: 'Aïssatou Diallo',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  // TEST_EMAIL_FROM non configurée dans ce test : `ApiKeyAuthGuard` calcule
  // `null` et le fusionne dans `request.user` (voir `resolveTestSenderAddress`).
  testSenderAddress: null,
};

/**
 * Double en mémoire de `PrismaService.apiKey`, avec une sémantique de
 * requête réelle (recherche par `id`/`keyHash`, mutation en place) plutôt
 * que des réponses pré-programmées par test. `ApiKeysService` et
 * `ApiKeyAuthGuard` s'en servent tous les deux dans ce fichier : la rotation
 * et l'authentification qui suit passent donc par le vrai code de
 * production (extraction du header, hash SHA-256, lookup par hash), pas par
 * une simple comparaison de deux chaînes de hash calculées à côté.
 */
class FakeApiKeyStore {
  private rows = new Map<string, Row>();
  private nextId = 1;

  create = jest.fn(
    ({
      data,
      select,
    }: {
      data: { userId: string; name: string; prefix: string; keyHash: string };
      select: Record<string, boolean>;
    }) => {
      const row: Row = {
        id: `key_${this.nextId++}`,
        userId: data.userId,
        name: data.name,
        prefix: data.prefix,
        keyHash: data.keyHash,
        lastUsedAt: null,
        revokedAt: null,
        rotatedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      this.rows.set(row.id, row);
      return Promise.resolve(this.project(row, select));
    },
  );

  findUnique = jest.fn(
    ({
      where,
      select,
    }: {
      where: { id?: string; keyHash?: string };
      select: Record<string, boolean>;
    }) => {
      const row = where.id
        ? this.rows.get(where.id)
        : [...this.rows.values()].find((r) => r.keyHash === where.keyHash);

      return Promise.resolve(row ? this.project(row, select) : null);
    },
  );

  update = jest.fn(
    ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = this.rows.get(where.id);
      if (!row) {
        throw new Error('Fake Prisma : ligne introuvable');
      }
      Object.assign(row, data);
      return Promise.resolve({ ...row });
    },
  );

  findMany = jest.fn(
    ({
      where,
      select,
    }: {
      where: { userId: string };
      select: Record<string, boolean>;
    }) => {
      const rows = [...this.rows.values()].filter(
        (r) => r.userId === where.userId,
      );
      return Promise.resolve(rows.map((row) => this.project(row, select)));
    },
  );

  private project(
    row: Row,
    select: Record<string, boolean>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(select)) {
      result[key] =
        key === 'user'
          ? owner
          : (row as unknown as Record<string, unknown>)[key];
    }
    return result;
  }
}

function contextFor(
  request: Partial<ApiKeyAuthenticatedRequest>,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('Rotation de clé API — chemin d’authentification réel', () => {
  let service: ApiKeysService;
  let guard: ApiKeyAuthGuard;

  beforeEach(async () => {
    const store = new FakeApiKeyStore();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        ApiKeyAuthGuard,
        { provide: PrismaService, useValue: { apiKey: store } },
        // TEST_EMAIL_FROM non configurée : `resolveTestSenderAddress` doit
        // renvoyer `null` (voir `owner.testSenderAddress` ci-dessus).
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<ApiKeysService>(ApiKeysService);
    guard = module.get<ApiKeyAuthGuard>(ApiKeyAuthGuard);
  });

  async function authenticate(plainKey: string) {
    const request: Partial<ApiKeyAuthenticatedRequest> = {
      headers: { authorization: `Bearer ${plainKey}` },
    };
    const ok = await guard.canActivate(contextFor(request));
    return { ok, request };
  }

  it('coupure immédiate : la valeur avant rotation cesse de fonctionner, la nouvelle fonctionne', async () => {
    const created = await service.create('user_1', { name: 'Prod' });

    // Sanity check : la clé d'origine authentifie bien avant la rotation.
    const before = await authenticate(created.key);
    expect(before.ok).toBe(true);
    expect(before.request.user).toEqual(owner);

    const rotated = await service.rotate('user_1', created.id);
    expect(rotated.key).not.toBe(created.key);

    // L'ancienne valeur ne doit plus authentifier, dès la rotation — pas de
    // grâce, pas de double secret valide.
    await expect(authenticate(created.key)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // La nouvelle valeur, elle, authentifie immédiatement.
    const after = await authenticate(rotated.key);
    expect(after.ok).toBe(true);
    expect(after.request.user).toEqual(owner);
  });

  it('identité, nom et date de création inchangés ; préfixe, hash et rotatedAt renouvelés', async () => {
    const created = await service.create('user_1', { name: 'Prod' });

    const rotated = await service.rotate('user_1', created.id);

    expect(rotated.id).toBe(created.id);
    expect(rotated.name).toBe(created.name);
    expect(rotated.createdAt).toEqual(created.createdAt);
    expect(rotated.prefix).not.toBe(created.prefix);
    expect(rotated.rotatedAt).toBeInstanceOf(Date);
  });

  it('ne renvoie jamais le secret en clair via la liste, ni à la création ni après rotation', async () => {
    const created = await service.create('user_1', { name: 'Prod' });
    const rotated = await service.rotate('user_1', created.id);

    const list = await service.findAllForUser('user_1');
    const serialized = JSON.stringify(list);

    expect(list).toHaveLength(1);
    expect(serialized).not.toContain(created.key);
    expect(serialized).not.toContain(rotated.key);
    expect(list[0]).not.toHaveProperty('key');
    expect(list[0]).not.toHaveProperty('keyHash');

    // Une seconde lecture n'expose pas davantage le secret.
    const secondRead = await service.findAllForUser('user_1');
    expect(JSON.stringify(secondRead)).not.toContain(rotated.key);
  });
});

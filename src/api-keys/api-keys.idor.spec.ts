import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { App } from 'supertest/types';
import { EmailVerifiedGuard, SessionAuthGuard, SessionService } from '../auth';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import { AllExceptionsFilter } from '../common/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { SecretHashingService } from './secret-hashing.service';

/**
 * E7 - accès inter-comptes sur les clés API, prouvé par de vraies requêtes
 * HTTP. Contrôleur, service et `SessionAuthGuard` réels ; seuls le magasin de
 * sessions et la base sont doublés. Le double de Prisma **applique les
 * filtres `where`** : c'est ce qui rend le test capable de détecter un
 * `findFirst` auquel manquerait `userId`.
 */
const userA = {
  id: 'user_a',
  email: 'aissatou@example.gn',
  name: 'Aïssatou Diallo',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  dailySendLimit: 1000,
  emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const userB = { ...userA, id: 'user_b', email: 'bintou@example.gn' };

const SESSIONS: Record<string, string> = {
  'token-a': userA.id,
  'token-b': userB.id,
};

interface KeyRow {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  keyHash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  rotatedAt: Date | null;
}

describe('E7 - clés API, cloisonnement entre comptes', () => {
  let app: INestApplication<App>;
  let rows: KeyRow[];

  function project(
    row: KeyRow,
    select: Record<string, boolean>,
  ): Record<string, unknown> {
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(select)) {
      projected[key] = (row as unknown as Record<string, unknown>)[key];
    }
    return projected;
  }

  const findFirst = jest.fn(
    ({
      where,
      select,
    }: {
      where: { id?: string; userId?: string };
      select: Record<string, boolean>;
    }) => {
      const row = rows.find(
        (candidate) =>
          (where.id === undefined || candidate.id === where.id) &&
          (where.userId === undefined || candidate.userId === where.userId),
      );
      return Promise.resolve(row ? project(row, select) : null);
    },
  );

  // Conservé parce que Prisma l'expose : si le service revenait à une
  // recherche par identifiant seul, ce double la servirait sans filtre - et
  // les assertions de ce fichier tomberaient, ce qui est le but.
  const findUnique = jest.fn(
    ({
      where,
      select,
    }: {
      where: { id?: string };
      select: Record<string, boolean>;
    }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      return Promise.resolve(row ? project(row, select) : null);
    },
  );

  const update = jest.fn(
    ({ where, data }: { where: { id: string }; data: Partial<KeyRow> }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (row) {
        Object.assign(row, data);
      }
      return Promise.resolve({});
    },
  );

  const deleteFn = jest.fn(({ where }: { where: { id: string } }) => {
    rows = rows.filter((row) => row.id !== where.id);
    return Promise.resolve({});
  });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApiKeysController],
      providers: [
        ApiKeysService,
        SecretHashingService,
        SessionAuthGuard,
        EmailVerifiedGuard,
        {
          provide: SessionService,
          useValue: {
            resolve: jest.fn((token: string) =>
              Promise.resolve(SESSIONS[token] ?? null),
            ),
            destroy: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn(({ where }: { where: { id: string } }) =>
                Promise.resolve(
                  [userA, userB].find((user) => user.id === where.id) ?? null,
                ),
              ),
            },
            apiKey: {
              findFirst,
              findUnique,
              findMany: jest.fn(() => Promise.resolve([])),
              create: jest.fn(),
              update,
              delete: deleteFn,
            },
          },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    app = module.createNestApplication<INestApplication<App>>();
    app.setGlobalPrefix('v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rows = [
      {
        id: 'key_a',
        userId: userA.id,
        name: 'Prod',
        prefix: 'zd_live_aaaa',
        keyHash: 'hash-a',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        lastUsedAt: null,
        revokedAt: null,
        rotatedAt: null,
      },
      {
        id: 'key_a_revoquee',
        userId: userA.id,
        name: 'Ancienne',
        prefix: 'zd_live_bbbb',
        keyHash: 'hash-a-revoquee',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        lastUsedAt: null,
        revokedAt: new Date('2026-01-02T00:00:00.000Z'),
        rotatedAt: null,
      },
    ];
  });

  const withCookie = (call: request.Test, token?: string) =>
    token ? call.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`) : call;

  const revoke = (id: string, token?: string) =>
    withCookie(
      request(app.getHttpServer()).delete(`/v1/api-keys/${id}`),
      token,
    );

  const rotate = (id: string, token?: string) =>
    withCookie(
      request(app.getHttpServer()).post(`/v1/api-keys/${id}/rotate`),
      token,
    );

  const purge = (id: string, token?: string) =>
    withCookie(
      request(app.getHttpServer()).delete(`/v1/api-keys/${id}/purge`),
      token,
    );

  /** Aucune écriture, sur aucune des deux méthodes qui en font. */
  function expectNoWrite() {
    expect(update).not.toHaveBeenCalled();
    expect(deleteFn).not.toHaveBeenCalled();
  }

  describe('DELETE /v1/api-keys/:id (révocation)', () => {
    it('révoque la clé de son propriétaire', async () => {
      const response = await revoke('key_a', 'token-a');

      expect(response.status).toBe(204);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('rend 401 sans cookie de session', async () => {
      const response = await revoke('key_a');

      expect(response.status).toBe(401);
      expectNoWrite();
    });

    it('rend à un autre compte exactement le 404 d’un identifiant inexistant, sans rien écrire', async () => {
      const foreign = await revoke('key_a', 'token-b');
      const missing = await revoke('key_inexistante', 'token-a');

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expectNoWrite();
    });

    it('restreint la recherche au propriétaire dans la requête elle-même', async () => {
      await revoke('key_a', 'token-b');

      const [args] = findFirst.mock.calls[0];
      expect(args.where).toEqual({ id: 'key_a', userId: userB.id });
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('POST /v1/api-keys/:id/rotate', () => {
    it('régénère la clé de son propriétaire', async () => {
      const response = await rotate('key_a', 'token-a');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('key');
    });

    it('rend 401 sans cookie de session', async () => {
      const response = await rotate('key_a');

      expect(response.status).toBe(401);
      expectNoWrite();
    });

    it('rend à un autre compte exactement le 404 d’un identifiant inexistant, sans rien écrire', async () => {
      const foreign = await rotate('key_a', 'token-b');
      const missing = await rotate('key_inexistante', 'token-a');

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expectNoWrite();
    });
  });

  describe('DELETE /v1/api-keys/:id/purge', () => {
    it('supprime définitivement une clé révoquée de son propriétaire', async () => {
      const response = await purge('key_a_revoquee', 'token-a');

      expect(response.status).toBe(204);
      expect(deleteFn).toHaveBeenCalledWith({
        where: { id: 'key_a_revoquee' },
      });
    });

    it('rend 401 sans cookie de session', async () => {
      const response = await purge('key_a_revoquee');

      expect(response.status).toBe(401);
      expectNoWrite();
    });

    it('rend à un autre compte exactement le 404 d’un identifiant inexistant, sans rien écrire', async () => {
      const foreign = await purge('key_a_revoquee', 'token-b');
      const missing = await purge('key_inexistante', 'token-a');

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expectNoWrite();
      expect(rows).toHaveLength(2);
    });
  });
});

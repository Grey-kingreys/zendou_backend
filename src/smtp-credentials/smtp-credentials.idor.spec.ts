import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SecretHashingService } from '../api-keys';
import { EmailVerifiedGuard, SessionAuthGuard, SessionService } from '../auth';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import { AllExceptionsFilter } from '../common/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { SmtpCredentialsController } from './smtp-credentials.controller';
import { SmtpCredentialsService } from './smtp-credentials.service';

/**
 * E7 - accès inter-comptes sur les identifiants SMTP, prouvé par de vraies
 * requêtes HTTP. Même montage que `api-keys.idor.spec.ts` : contrôleur,
 * service et `SessionAuthGuard` réels, double de Prisma qui **applique les
 * filtres `where`**.
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

interface CredentialRow {
  id: string;
  userId: string;
  name: string;
  username: string;
  prefix: string;
  secretHash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  rotatedAt: Date | null;
}

describe('E7 - identifiants SMTP, cloisonnement entre comptes', () => {
  let app: INestApplication<App>;
  let rows: CredentialRow[];

  function project(
    row: CredentialRow,
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

  // Conservé parce que Prisma l'expose : une recherche par identifiant seul
  // servirait la ligne sans filtre - et les assertions de ce fichier
  // tomberaient, ce qui est exactement le but.
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
    ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<CredentialRow>;
    }) => {
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
      controllers: [SmtpCredentialsController],
      providers: [
        SmtpCredentialsService,
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
            smtpCredential: {
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
        id: 'smtp_a',
        userId: userA.id,
        name: 'WordPress boutique',
        username: 'zdu_aaaaaaaaaaaaaaaa',
        prefix: 'zd_smtp_aaaa',
        secretHash: 'hash-a',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        lastUsedAt: null,
        revokedAt: null,
        rotatedAt: null,
      },
      {
        id: 'smtp_a_revoque',
        userId: userA.id,
        name: 'Ancien',
        username: 'zdu_bbbbbbbbbbbbbbbb',
        prefix: 'zd_smtp_bbbb',
        secretHash: 'hash-a-revoque',
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
      request(app.getHttpServer()).delete(`/v1/smtp-credentials/${id}`),
      token,
    );

  const rotate = (id: string, token?: string) =>
    withCookie(
      request(app.getHttpServer()).post(`/v1/smtp-credentials/${id}/rotate`),
      token,
    );

  const purge = (id: string, token?: string) =>
    withCookie(
      request(app.getHttpServer()).delete(`/v1/smtp-credentials/${id}/purge`),
      token,
    );

  function expectNoWrite() {
    expect(update).not.toHaveBeenCalled();
    expect(deleteFn).not.toHaveBeenCalled();
  }

  describe('DELETE /v1/smtp-credentials/:id (révocation)', () => {
    it('révoque l’identifiant de son propriétaire', async () => {
      const response = await revoke('smtp_a', 'token-a');

      expect(response.status).toBe(204);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('rend 401 sans cookie de session', async () => {
      const response = await revoke('smtp_a');

      expect(response.status).toBe(401);
      expectNoWrite();
    });

    it('rend à un autre compte exactement le 404 d’un identifiant inexistant, sans rien écrire', async () => {
      const foreign = await revoke('smtp_a', 'token-b');
      const missing = await revoke('smtp_inexistant', 'token-a');

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expectNoWrite();
    });

    it('restreint la recherche au propriétaire dans la requête elle-même', async () => {
      await revoke('smtp_a', 'token-b');

      const [args] = findFirst.mock.calls[0];
      expect(args.where).toEqual({ id: 'smtp_a', userId: userB.id });
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('POST /v1/smtp-credentials/:id/rotate', () => {
    it('régénère l’identifiant de son propriétaire', async () => {
      const response = await rotate('smtp_a', 'token-a');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('password');
    });

    it('rend 401 sans cookie de session', async () => {
      const response = await rotate('smtp_a');

      expect(response.status).toBe(401);
      expectNoWrite();
    });

    it('rend à un autre compte exactement le 404 d’un identifiant inexistant, sans rien écrire', async () => {
      const foreign = await rotate('smtp_a', 'token-b');
      const missing = await rotate('smtp_inexistant', 'token-a');

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expectNoWrite();
    });
  });

  describe('DELETE /v1/smtp-credentials/:id/purge', () => {
    it('supprime définitivement un identifiant révoqué de son propriétaire', async () => {
      const response = await purge('smtp_a_revoque', 'token-a');

      expect(response.status).toBe(204);
      expect(deleteFn).toHaveBeenCalledWith({
        where: { id: 'smtp_a_revoque' },
      });
    });

    it('rend 401 sans cookie de session', async () => {
      const response = await purge('smtp_a_revoque');

      expect(response.status).toBe(401);
      expectNoWrite();
    });

    it('rend à un autre compte exactement le 404 d’un identifiant inexistant, sans rien écrire', async () => {
      const foreign = await purge('smtp_a_revoque', 'token-b');
      const missing = await purge('smtp_inexistant', 'token-a');

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expectNoWrite();
      expect(rows).toHaveLength(2);
    });
  });
});

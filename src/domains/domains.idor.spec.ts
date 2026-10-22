import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DomainStatus, UserRole, UserStatus } from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApiKeyAuthGuard } from '../api-keys';
import { SessionAuthGuard, SessionService } from '../auth';
import { SessionOrApiKeyGuard } from '../common/session-or-api-key.guard';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import { AllExceptionsFilter } from '../common/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';
import { SES_IDENTITY_DRIVER } from './ses/ses-identity-driver';

/**
 * E7 - accès inter-comptes sur les domaines, prouvé par de vraies requêtes
 * HTTP. Contrôleur, service et `SessionAuthGuard` réels ; seuls le magasin de
 * sessions, la base et le pilote SES sont doublés. Le double de Prisma
 * **applique les filtres `where`** : un filtre de propriété absent de la
 * requête ferait échouer le test, ce qui est tout l'intérêt.
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

interface DomainRow {
  id: string;
  userId: string;
  name: string;
  status: DomainStatus;
  dkimTokens: string[];
  verifiedAt: Date | null;
  createdAt: Date;
}

describe('E7 - domaines, cloisonnement entre comptes', () => {
  let app: INestApplication<App>;
  let rows: DomainRow[];

  const update = jest.fn();
  const deleteFn = jest.fn(({ where }: { where: { id: string } }) => {
    rows = rows.filter((row) => row.id !== where.id);
    return Promise.resolve({});
  });
  const deleteIdentity = jest.fn(() => Promise.resolve());
  // Liens de portée (B27) : aucun ici, la suppression ne révoque rien.
  const apiKeyDomain = {
    findMany: jest.fn(() => Promise.resolve([])),
    deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
  };
  const smtpCredentialDomain = {
    findMany: jest.fn(() => Promise.resolve([])),
    deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
  };
  const prismaDouble: Record<string, unknown> = {};

  const domainFindFirst = jest.fn(
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

      if (!row) {
        return Promise.resolve(null);
      }

      const projected: Record<string, unknown> = {};
      for (const key of Object.keys(select)) {
        projected[key] = (row as unknown as Record<string, unknown>)[key];
      }
      return Promise.resolve(projected);
    },
  );

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DomainsController],
      providers: [
        DomainsService,
        SessionAuthGuard,
        SessionOrApiKeyGuard,
        // Ces specs ne présentent jamais de clé API : le garde de clé est un stub.
        { provide: ApiKeyAuthGuard, useValue: { canActivate: jest.fn() } },
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
          useValue: Object.assign(prismaDouble, {
            $transaction: (run: (tx: unknown) => Promise<unknown>) =>
              run(prismaDouble),
            apiKeyDomain,
            smtpCredentialDomain,
            $queryRaw: jest.fn(() => Promise.resolve([])),
            apiKey: { updateMany: jest.fn() },
            smtpCredential: { updateMany: jest.fn() },
            user: {
              findUnique: jest.fn(({ where }: { where: { id: string } }) =>
                Promise.resolve(
                  [userA, userB].find((user) => user.id === where.id) ?? null,
                ),
              ),
            },
            domain: {
              findFirst: domainFindFirst,
              findMany: jest.fn(() => Promise.resolve([])),
              update,
              delete: deleteFn,
            },
          }),
        },
        {
          provide: SES_IDENTITY_DRIVER,
          useValue: {
            createIdentity: jest.fn(),
            getIdentityStatus: jest.fn(),
            deleteIdentity,
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
        id: 'dom_a',
        userId: userA.id,
        name: 'boutique.gn',
        status: DomainStatus.PENDING,
        dkimTokens: ['t1', 't2', 't3'],
        verifiedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ];
  });

  const withCookie = (
    call: request.Test,
    token?: string,
  ): request.Test | Promise<request.Response> =>
    token ? call.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`) : call;

  const getDomain = (id: string, token?: string) =>
    withCookie(request(app.getHttpServer()).get(`/v1/domains/${id}`), token);

  const deleteDomain = (id: string, token?: string) =>
    withCookie(request(app.getHttpServer()).delete(`/v1/domains/${id}`), token);

  describe('GET /v1/domains/:id', () => {
    it('rend le détail au propriétaire', async () => {
      const response = await getDomain('dom_a', 'token-a');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('name', 'boutique.gn');
    });

    it('rend 401 sans cookie de session', async () => {
      const response = await getDomain('dom_a');

      expect(response.status).toBe(401);
      expect(domainFindFirst).not.toHaveBeenCalled();
    });

    it('rend à un autre compte exactement le 404 d’un identifiant inexistant', async () => {
      const foreign = await getDomain('dom_a', 'token-b');
      const missing = await getDomain('dom_inexistant', 'token-a');

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
    });
  });

  describe("GET /v1/domains/:id/usage (aperçu d'impact, B27)", () => {
    const getUsage = (id: string, token?: string) =>
      withCookie(
        request(app.getHttpServer()).get(`/v1/domains/${id}/usage`),
        token,
      );

    it("rend l'aperçu au propriétaire", async () => {
      const response = await getUsage('dom_a', 'token-a');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ apiKeys: [], smtpCredentials: [] });
    });

    it('rend 401 sans cookie de session', async () => {
      const response = await getUsage('dom_a');

      expect(response.status).toBe(401);
      expect(apiKeyDomain.findMany).not.toHaveBeenCalled();
    });

    it("rend à un autre compte exactement le 404 d'un identifiant inexistant, sans rien lire", async () => {
      const foreign = await getUsage('dom_a', 'token-b');
      const missing = await getUsage('dom_inexistant', 'token-a');

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expect(apiKeyDomain.findMany).not.toHaveBeenCalled();
      expect(smtpCredentialDomain.findMany).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /v1/domains/:id', () => {
    it('supprime le domaine de son propriétaire et rend ce qui a été révoqué', async () => {
      const response = await deleteDomain('dom_a', 'token-a');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        revokedApiKeys: [],
        revokedSmtpCredentials: [],
        remainingActions: [],
      });
      expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'dom_a' } });
    });

    it('rend 401 sans cookie de session', async () => {
      const response = await deleteDomain('dom_a');

      expect(response.status).toBe(401);
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('rend à un autre compte exactement le 404 d’un identifiant inexistant, sans rien écrire', async () => {
      const foreign = await deleteDomain('dom_a', 'token-b');
      const missing = await deleteDomain('dom_inexistant', 'token-a');

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);

      // Ni écriture en base, ni effet de bord chez SES : le domaine de A est
      // toujours là, et son identité SES n'a jamais été touchée.
      expect(deleteFn).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(deleteIdentity).not.toHaveBeenCalled();
      expect(rows).toHaveLength(1);
    });
  });
});

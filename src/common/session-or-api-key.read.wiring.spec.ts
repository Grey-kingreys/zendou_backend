import { getQueueToken } from '@nestjs/bullmq';
import { Global, Module, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import {
  EmailChannel,
  EmailStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { validationExceptionFactory } from '../app-setup';
import { ApiKeysModule, hashApiKey } from '../api-keys';
import { API_KEY_FAILURE_KEY_PREFIX } from '../api-keys/api-keys.constants';
import { SESSION_COOKIE_NAME, SESSION_REDIS, SessionService } from '../auth';
import { DOMAIN_NOT_FOUND_MESSAGE } from '../domains/domains.constants';
import { DomainsModule } from '../domains/domains.module';
import { EmailsLogModule } from '../emails-log/emails-log.module';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import { RATE_LIMIT_REDIS } from '../rate-limit/rate-limit.constants';
import { ReputationService } from '../reputation';
import { AllExceptionsFilter } from './http-exception.filter';

const READ_FORBIDDEN =
  "Cette clé API n'a pas l'autorisation de lecture : créez une clé avec la lecture autorisée.";

/** Double de `ioredis` du compteur d'échecs : ne bloque jamais, garde les clés. */
class FakeThrottleRedis {
  readonly keys: string[] = [];

  defineCommand(name: string): void {
    (this as unknown as Record<string, unknown>)[name] = (
      hitsKey: string,
    ): Promise<[number, number, number, number]> => {
      this.keys.push(hitsKey);
      return Promise.resolve([1, 60_000, 0, 0]);
    };
  }

  disconnect(): void {
    // Aucune socket ouverte.
  }
}

const userBase = {
  name: 'Aïssatou',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  dailySendLimit: 1000,
  emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  passwordHash: null,
  googleSub: null,
};
const user1 = { ...userBase, id: 'user_1', email: 'aissatou@exemple.gn' };
const user2 = { ...userBase, id: 'user_2', email: 'bintou@exemple.gn' };
const userSuspended = {
  ...userBase,
  id: 'user_s',
  email: 'suspendu@exemple.gn',
  status: UserStatus.SUSPENDED,
};

const keyOf = (letter: string) => `zd_live_${letter.repeat(43)}`;
const KEYS = {
  noRead: keyOf('a'),
  all: keyOf('b'),
  selected: keyOf('c'),
  selectedEmpty: keyOf('d'),
  revoked: keyOf('e'),
  suspended: keyOf('f'),
  unknown: keyOf('z'),
};

interface KeyRow {
  id: string;
  keyHash: string;
  revokedAt: Date | null;
  canRead: boolean;
  domainScope: 'ALL' | 'SELECTED';
  domains: { domainId: string }[];
  user: typeof user1 | typeof userSuspended;
}

const keyRows: KeyRow[] = [
  {
    id: 'k_noread',
    keyHash: hashApiKey(KEYS.noRead),
    revokedAt: null,
    canRead: false,
    domainScope: 'ALL',
    domains: [],
    user: user1,
  },
  {
    id: 'k_all',
    keyHash: hashApiKey(KEYS.all),
    revokedAt: null,
    canRead: true,
    domainScope: 'ALL',
    domains: [],
    user: user1,
  },
  {
    id: 'k_sel',
    keyHash: hashApiKey(KEYS.selected),
    revokedAt: null,
    canRead: true,
    domainScope: 'SELECTED',
    domains: [{ domainId: 'dom_a' }],
    user: user1,
  },
  {
    id: 'k_sel_empty',
    keyHash: hashApiKey(KEYS.selectedEmpty),
    revokedAt: null,
    canRead: true,
    domainScope: 'SELECTED',
    domains: [],
    user: user1,
  },
  {
    id: 'k_revoked',
    keyHash: hashApiKey(KEYS.revoked),
    revokedAt: new Date('2026-02-01T00:00:00.000Z'),
    canRead: true,
    domainScope: 'ALL',
    domains: [],
    user: user1,
  },
  {
    id: 'k_susp',
    keyHash: hashApiKey(KEYS.suspended),
    revokedAt: null,
    canRead: true,
    domainScope: 'ALL',
    domains: [],
    user: userSuspended,
  },
];

interface DomainRow {
  id: string;
  userId: string;
  name: string;
  status: 'PENDING' | 'VERIFIED';
  dkimTokens: string[];
  mailFromStatus: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  /** Champ interne qu'aucune réponse ne doit exposer. */
  sesIdentityArn: string;
}

const domainRow = (id: string, userId: string, day: number): DomainRow => ({
  id,
  userId,
  name: `${id.replace('dom_', '')}.exemple.gn`,
  status: 'VERIFIED',
  dkimTokens: ['tok1', 'tok2', 'tok3'],
  mailFromStatus: 'SUCCESS',
  verifiedAt: new Date(`2026-03-0${day}T00:00:00.000Z`),
  createdAt: new Date(`2026-03-0${day}T00:00:00.000Z`),
  sesIdentityArn: 'arn:aws:ses:eu-west-3:123456789012:identity/interne',
});

const domainRows: DomainRow[] = [
  domainRow('dom_a', 'user_1', 1),
  domainRow('dom_b', 'user_1', 2),
  domainRow('dom_x', 'user_2', 3),
];

interface EmailRow {
  publicId: string;
  userId: string;
  domainId: string | null;
  system: boolean;
  fromAddress: string;
  toAddress: string;
  subject: string;
  status: EmailStatus;
  channel: EmailChannel;
  queuedAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  lastEventAt: Date | null;
  errorMessage: string | null;
  sesMessageId: string | null;
  smtpCredentialId: string | null;
}

const emailRow = (
  publicId: string,
  over: Partial<EmailRow>,
  minute: number,
): EmailRow => ({
  publicId,
  userId: 'user_1',
  domainId: 'dom_a',
  system: false,
  fromAddress: 'contact@a.exemple.gn',
  toAddress: 'mariama@exemple.gn',
  subject: `Sujet ${publicId}`,
  status: EmailStatus.DELIVERED,
  channel: EmailChannel.API,
  queuedAt: new Date(Date.UTC(2026, 3, 1, 10, minute)),
  sentAt: null,
  deliveredAt: null,
  lastEventAt: null,
  errorMessage: null,
  sesMessageId: null,
  smtpCredentialId: null,
  ...over,
});

const emailRows: EmailRow[] = [
  emailRow('em_a1', {}, 1),
  emailRow('em_a2', { channel: EmailChannel.SMTP }, 2),
  emailRow('em_b1', { domainId: 'dom_b', status: EmailStatus.BOUNCED }, 3),
  // Bac à sable : aucun domaine expéditeur.
  emailRow('em_sandbox', { domainId: null }, 4),
  // Envoi système : jamais dans le journal.
  emailRow('em_system', { system: true }, 5),
  // Autre compte.
  emailRow('em_other', { userId: 'user_2', domainId: 'dom_x' }, 6),
];

type Where = Record<string, unknown>;

/** Applique les filtres `where` réellement utilisés par les services de lecture. */
function matchesEmail(row: EmailRow, where: Where): boolean {
  const domainId = where.domainId as { in: string[] } | undefined;

  return (
    (where.userId === undefined || row.userId === where.userId) &&
    (where.system === undefined || row.system === where.system) &&
    (where.publicId === undefined || row.publicId === where.publicId) &&
    (where.status === undefined || row.status === where.status) &&
    (where.channel === undefined || row.channel === where.channel) &&
    (domainId === undefined ||
      (row.domainId !== null && domainId.in.includes(row.domainId)))
  );
}

function project(
  row: object,
  select: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const record = row as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(select ?? record)) {
    result[key] = record[key];
  }

  return result;
}

/** Corps JSON d'une réponse, typé pour ce qu'on y lit ici. */
interface Body {
  items: { publicId: string }[];
  total: number;
  totalPages: number;
  publicId: string;
  canRead: boolean;
  message: string;
  errors: string[];
}

const body = (response: request.Response): Body => response.body as Body;
const rows = (response: request.Response): { id: string; canRead: boolean }[] =>
  response.body as { id: string; canRead: boolean }[];

const createdKeys: Record<string, unknown>[] = [];

const prisma = {
  apiKey: {
    findUnique: jest.fn(
      ({
        where,
        select,
      }: {
        where: { keyHash?: string; id?: string };
        select: Record<string, unknown>;
      }) => {
        const row = keyRows.find(
          (candidate) =>
            candidate.keyHash === where.keyHash || candidate.id === where.id,
        );

        if (!row) {
          return Promise.resolve(null);
        }

        const result = project(row, select);

        if ('domains' in select) {
          result.domains = row.domains.map((link) => ({
            ...link,
            domain: { id: link.domainId, name: `${link.domainId}.gn` },
          }));
        }

        return Promise.resolve(result);
      },
    ),
    update: jest.fn(() => Promise.resolve({})),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      createdKeys.push(data);
      return Promise.resolve({
        id: 'k_new',
        name: data.name,
        prefix: data.prefix,
        canRead: data.canRead,
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
        domainScope: 'ALL',
        domains: [],
      });
    }),
    findMany: jest.fn(() =>
      Promise.resolve([
        {
          id: 'k_all',
          name: 'Lecture',
          prefix: 'zd_live_bbbb',
          canRead: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          lastUsedAt: null,
          revokedAt: null,
          domainScope: 'ALL',
          domains: [],
        },
      ]),
    ),
  },
  user: {
    findUnique: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        [user1, user2, userSuspended].find((u) => u.id === where.id) ?? null,
      ),
    ),
  },
  email: {
    findMany: jest.fn(
      ({
        where,
        select,
        skip,
        take,
      }: {
        where: Where;
        select: Record<string, unknown>;
        skip: number;
        take: number;
      }) =>
        Promise.resolve(
          emailRows
            .filter((row) => matchesEmail(row, where))
            .sort((a, b) => b.queuedAt.getTime() - a.queuedAt.getTime())
            .slice(skip, skip + take)
            .map((row) => project(row, select)),
        ),
    ),
    count: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(
        emailRows.filter((row) => matchesEmail(row, where)).length,
      ),
    ),
    findFirst: jest.fn(
      ({
        where,
        select,
      }: {
        where: Where;
        select: Record<string, unknown>;
      }) => {
        const row = emailRows.find((candidate) =>
          matchesEmail(candidate, where),
        );
        return Promise.resolve(row ? project(row, select) : null);
      },
    ),
  },
  domain: {
    findMany: jest.fn(
      ({
        where,
        select,
      }: {
        where: { userId: string; id?: { in: string[] } };
        select: Record<string, unknown>;
      }) =>
        Promise.resolve(
          domainRows
            .filter(
              (row) =>
                row.userId === where.userId &&
                (where.id === undefined || where.id.in.includes(row.id)),
            )
            .map((row) => project(row, select)),
        ),
    ),
    findFirst: jest.fn(
      ({
        where,
        select,
      }: {
        where: { id: string; userId: string };
        select: Record<string, unknown>;
      }) => {
        const row = domainRows.find(
          (candidate) =>
            candidate.id === where.id && candidate.userId === where.userId,
        );
        return Promise.resolve(row ? project(row, select) : null);
      },
    ),
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn(),
};

const sessionService = {
  resolve: jest.fn((token: string) =>
    Promise.resolve(token === 'session-1' ? 'user_1' : null),
  ),
  destroy: jest.fn(),
};

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
    { provide: ReputationService, useValue: {} },
  ],
  exports: [PrismaService, ConfigService, ReputationService],
})
class InfrastructureDoubleModule {}

/**
 * Lecture par clé API (lot M1), vérifiée avec les **vrais** `EmailsLogModule`,
 * `DomainsModule` et `ApiKeysModule`, garde câblé tel qu'en production : seuls
 * la base (qui applique réellement les filtres `where`), la file et Redis sont
 * doublés.
 */
describe('Lecture par clé API - câblage réel (journal et domaines)', () => {
  let app: NestExpressApplication;
  let redis: FakeThrottleRedis;

  beforeAll(async () => {
    redis = new FakeThrottleRedis();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        InfrastructureDoubleModule,
        EmailsLogModule,
        DomainsModule,
        ApiKeysModule,
      ],
    })
      .overrideProvider(getQueueToken(EMAIL_SEND_QUEUE))
      .useValue({ add: jest.fn() })
      .overrideProvider(RATE_LIMIT_REDIS)
      .useValue(redis)
      .overrideProvider(SESSION_REDIS)
      .useValue({ disconnect: jest.fn() })
      .overrideProvider(SessionService)
      .useValue(sessionService)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use(cookieParser());
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        exceptionFactory: validationExceptionFactory,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    redis.keys.length = 0;
    createdKeys.length = 0;
    prisma.domain.create.mockClear();
    prisma.domain.update.mockClear();
    prisma.domain.delete.mockClear();
    prisma.$transaction.mockClear();
  });

  const get = (url: string, key?: string) => {
    const req = request(app.getHttpServer()).get(url);
    return key ? req.set('Authorization', `Bearer ${key}`) : req;
  };

  const publicIds = (response: request.Response) =>
    body(response).items.map((item) => item.publicId);

  describe('contrat d’erreur et authentification', () => {
    it.each([
      '/v1/emails',
      '/v1/emails/em_a1',
      '/v1/domains',
      '/v1/domains/dom_a',
    ])('refuse en 403 G1 une clé sans lecture sur %s', async (url) => {
      const response = await get(url, KEYS.noRead);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        message: READ_FORBIDDEN,
        errors: [READ_FORBIDDEN],
      });
    });

    it('ne touche à aucune donnée quand la clé n’a pas la lecture', async () => {
      prisma.email.findMany.mockClear();
      prisma.domain.findMany.mockClear();

      await get('/v1/emails', KEYS.noRead);
      await get('/v1/domains', KEYS.noRead);

      expect(prisma.email.findMany).not.toHaveBeenCalled();
      expect(prisma.domain.findMany).not.toHaveBeenCalled();
    });

    it.each([
      '/v1/emails',
      '/v1/emails/em_a1',
      '/v1/domains',
      '/v1/domains/dom_a',
    ])('refuse en 401 une clé révoquée sur %s', async (url) => {
      const response = await get(url, KEYS.revoked);

      expect(response.status).toBe(401);
      expect(body(response).message).toBe('Clé API invalide ou révoquée');
    });

    it.each([
      '/v1/emails',
      '/v1/emails/em_a1',
      '/v1/domains',
      '/v1/domains/dom_a',
    ])('refuse en 401 une clé inconnue sur %s', async (url) => {
      const response = await get(url, KEYS.unknown);

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        message: 'Clé API invalide ou révoquée',
        errors: ['Clé API invalide ou révoquée'],
      });
    });

    it('compte chaque échec de clé dans le compteur par IP', async () => {
      await get('/v1/emails', KEYS.unknown);
      await get('/v1/domains', KEYS.revoked);

      expect(redis.keys).toHaveLength(2);
      expect(
        redis.keys.every((key) => key.includes(API_KEY_FAILURE_KEY_PREFIX)),
      ).toBe(true);
    });

    it('ne compte pas d’échec pour une clé valide', async () => {
      await get('/v1/emails', KEYS.all);

      expect(redis.keys).toHaveLength(0);
    });

    it.each([
      '/v1/emails',
      '/v1/emails/em_a1',
      '/v1/domains',
      '/v1/domains/dom_a',
    ])('refuse en 403 un compte suspendu sur %s', async (url) => {
      const response = await get(url, KEYS.suspended);

      expect(response.status).toBe(403);
      expect(body(response).message).toBe('Ce compte est suspendu');
    });

    it('répond 401 sans session ni clé', async () => {
      expect((await get('/v1/emails')).status).toBe(401);
      expect((await get('/v1/domains')).status).toBe(401);
    });
  });

  describe('clé ALL avec lecture', () => {
    it('lit tout le journal du compte, bac à sable compris, sans envoi système ni autre compte', async () => {
      const response = await get('/v1/emails', KEYS.all);

      expect(response.status).toBe(200);
      expect(publicIds(response)).toEqual([
        'em_sandbox',
        'em_b1',
        'em_a2',
        'em_a1',
      ]);
      expect(body(response).total).toBe(4);
    });

    it('lit le détail d’un envoi du bac à sable', async () => {
      const response = await get('/v1/emails/em_sandbox', KEYS.all);

      expect(response.status).toBe(200);
      expect(body(response).publicId).toBe('em_sandbox');
    });

    it('garde les filtres existants et la pagination', async () => {
      const filtered = await get('/v1/emails?status=BOUNCED', KEYS.all);
      expect(publicIds(filtered)).toEqual(['em_b1']);
      expect(body(filtered).total).toBe(1);

      const page = await get('/v1/emails?limit=2&page=2', KEYS.all);
      expect(publicIds(page)).toEqual(['em_a2', 'em_a1']);
      expect(page.body).toMatchObject({
        total: 4,
        page: 2,
        limit: 2,
        totalPages: 2,
      });
    });

    it('ne rend jamais l’envoi système ni celui d’un autre compte', async () => {
      expect((await get('/v1/emails/em_system', KEYS.all)).status).toBe(404);
      expect((await get('/v1/emails/em_other', KEYS.all)).status).toBe(404);
    });

    it('lit les domaines du compte, jamais ceux d’un autre', async () => {
      const list = await get('/v1/domains', KEYS.all);
      expect(list.status).toBe(200);
      expect(
        rows(list)
          .map((d) => d.id)
          .sort(),
      ).toEqual(['dom_a', 'dom_b']);

      expect((await get('/v1/domains/dom_b', KEYS.all)).status).toBe(200);
      expect((await get('/v1/domains/dom_x', KEYS.all)).status).toBe(404);
    });
  });

  describe('clé SELECTED avec lecture (portée B27)', () => {
    it('ne voit que les envois de ses domaines : ni le bac à sable ni les autres domaines', async () => {
      const response = await get('/v1/emails', KEYS.selected);

      expect(response.status).toBe(200);
      expect(publicIds(response)).toEqual(['em_a2', 'em_a1']);
    });

    it('limite total et totalPages à la portée, sans fuite du volume du compte', async () => {
      const response = await get('/v1/emails?limit=1', KEYS.selected);

      expect(body(response).total).toBe(2);
      expect(body(response).totalPages).toBe(2);
      expect(publicIds(response)).toEqual(['em_a2']);
    });

    it('rend une liste vide, total 0, quand le filtre ne porte que sur des envois hors portée', async () => {
      const response = await get('/v1/emails?status=BOUNCED', KEYS.selected);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ items: [], total: 0 });
    });

    it('répond 404 sur le détail d’un envoi hors portée, du bac à sable ou inexistant, avec le même corps', async () => {
      const outOfScope = await get('/v1/emails/em_b1', KEYS.selected);
      const sandbox = await get('/v1/emails/em_sandbox', KEYS.selected);
      const missing = await get('/v1/emails/em_nope', KEYS.selected);

      for (const response of [outOfScope, sandbox, missing]) {
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({
          message: 'Email introuvable',
          errors: ['Email introuvable'],
        });
      }
      expect(outOfScope.body).toEqual(missing.body);
      expect(sandbox.body).toEqual(missing.body);
    });

    it('rend le détail d’un envoi de sa portée', async () => {
      const response = await get('/v1/emails/em_a1', KEYS.selected);

      expect(response.status).toBe(200);
      expect(body(response).publicId).toBe('em_a1');
    });

    it('ne liste que ses domaines et répond 404 sur les autres', async () => {
      const list = await get('/v1/domains', KEYS.selected);
      expect(rows(list).map((d) => d.id)).toEqual(['dom_a']);

      expect((await get('/v1/domains/dom_a', KEYS.selected)).status).toBe(200);

      const outOfScope = await get('/v1/domains/dom_b', KEYS.selected);
      const missing = await get('/v1/domains/dom_nope', KEYS.selected);
      expect(outOfScope.status).toBe(404);
      expect(outOfScope.body).toMatchObject({
        message: DOMAIN_NOT_FOUND_MESSAGE,
      });
      expect(outOfScope.body).toEqual(missing.body);
    });

    it('une portée SELECTED sans domaine ne voit rien, elle ne devient jamais universelle', async () => {
      const emails = await get('/v1/emails', KEYS.selectedEmpty);
      expect(emails.status).toBe(200);
      expect(emails.body).toMatchObject({ items: [], total: 0 });

      const domains = await get('/v1/domains', KEYS.selectedEmpty);
      expect(rows(domains)).toEqual([]);

      expect((await get('/v1/emails/em_a1', KEYS.selectedEmpty)).status).toBe(
        404,
      );
      expect((await get('/v1/domains/dom_a', KEYS.selectedEmpty)).status).toBe(
        404,
      );
    });
  });

  describe('réponses domaines lues par clé', () => {
    it('n’exposent aucun champ interne (identifiant ou ARN SES, jetons bruts)', async () => {
      const list = await get('/v1/domains', KEYS.all);
      const detail = await get('/v1/domains/dom_a', KEYS.all);

      expect(Object.keys(rows(list)[0]).sort()).toEqual([
        'createdAt',
        'id',
        'name',
        'status',
        'verifiedAt',
      ]);
      expect(Object.keys(detail.body as object).sort()).toEqual([
        'createdAt',
        'dkimRecords',
        'id',
        'mailFromDomain',
        'mailFromStatus',
        'name',
        'recommendedRecords',
        'status',
        'verifiedAt',
      ]);
      expect(JSON.stringify([body(list), body(detail)])).not.toMatch(
        /arn:aws|sesIdentityArn|dkimTokens/,
      );
    });
  });

  describe('session inchangée', () => {
    it('sert toujours la session, sans restriction de portée ni de clé', async () => {
      const emails = await request(app.getHttpServer())
        .get('/v1/emails')
        .set('Cookie', `${SESSION_COOKIE_NAME}=session-1`);
      const domains = await request(app.getHttpServer())
        .get('/v1/domains')
        .set('Cookie', `${SESSION_COOKIE_NAME}=session-1`);

      expect(emails.status).toBe(200);
      expect(body(emails).total).toBe(4);
      expect(rows(domains)).toHaveLength(2);
    });
  });

  describe('routes d’écriture et de diagnostic fermées aux clés', () => {
    const cases: [string, string][] = [
      ['post', '/v1/domains'],
      ['post', '/v1/domains/dom_a/check'],
      ['get', '/v1/domains/dom_a/dns-check'],
      ['get', '/v1/domains/dom_a/usage'],
      ['delete', '/v1/domains/dom_a'],
    ];

    it.each(cases)(
      'refuse une clé avec lecture sur %s %s (session seulement)',
      async (method, url) => {
        const agent = request(app.getHttpServer()) as unknown as Record<
          string,
          (path: string) => request.Test
        >;
        const response = await agent[method](url)
          .set('Authorization', `Bearer ${KEYS.all}`)
          .send({ name: 'pirate.gn' });

        expect(response.status).toBe(401);
        expect(prisma.domain.create).not.toHaveBeenCalled();
        expect(prisma.domain.update).not.toHaveBeenCalled();
        expect(prisma.domain.delete).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('refuse une clé sur la gestion des clés API elles-mêmes', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/api-keys')
        .set('Authorization', `Bearer ${KEYS.all}`)
        .send({ name: 'Rebond', canRead: true });

      expect(response.status).toBe(401);
      expect(createdKeys).toHaveLength(0);
    });
  });

  describe('création de clé avec lecture', () => {
    const post = (body: object) =>
      request(app.getHttpServer())
        .post('/v1/api-keys')
        .set('Cookie', `${SESSION_COOKIE_NAME}=session-1`)
        .send(body);

    it('crée une clé avec lecture quand canRead est true', async () => {
      const response = await post({ name: 'Assistant', canRead: true });

      expect(response.status).toBe(201);
      expect(body(response).canRead).toBe(true);
      expect(createdKeys[0].canRead).toBe(true);
    });

    it('crée une clé sans lecture par défaut', async () => {
      const response = await post({ name: 'Serveur' });

      expect(response.status).toBe(201);
      expect(body(response).canRead).toBe(false);
      expect(createdKeys[0].canRead).toBe(false);
    });

    it.each(['true', 1, 'oui'])(
      'refuse en 400 G1 un canRead non booléen (%p)',
      async (value) => {
        const response = await post({ name: 'Assistant', canRead: value });

        expect(response.status).toBe(400);
        expect(body(response).message).toBe(
          'La permission de lecture doit être un booléen',
        );
        expect(body(response).errors).toEqual([body(response).message]);
        expect(createdKeys).toHaveLength(0);
      },
    );

    it('expose canRead dans la liste des clés', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/api-keys')
        .set('Cookie', `${SESSION_COOKIE_NAME}=session-1`);

      expect(response.status).toBe(200);
      expect(rows(response)[0].canRead).toBe(true);
    });
  });
});

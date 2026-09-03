import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  EmailChannel,
  EmailStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SessionAuthGuard, SessionService } from '../auth';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import { AllExceptionsFilter } from '../common/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { EmailsLogController } from './emails-log.controller';
import { EmailsLogService } from './emails-log.service';

/**
 * E7 - accès inter-comptes sur le journal des envois, prouvé par de vraies
 * requêtes HTTP.
 *
 * Rien n'est doublé de ce qui décide : le contrôleur, le service et
 * `SessionAuthGuard` sont les classes de production, montées dans une
 * application Nest avec le filtre d'erreur et le `ValidationPipe` globaux.
 * Seuls le magasin de sessions (Redis) et la base sont doublés -
 * et le double de Prisma **applique réellement les filtres `where`**, sans
 * quoi le test prouverait le contraire de ce qu'il prétend : un filtre oublié
 * dans la requête passerait inaperçu.
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

interface EmailRow {
  publicId: string;
  userId: string;
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

describe('E7 - journal des envois, cloisonnement entre comptes', () => {
  let app: INestApplication<App>;
  let rows: EmailRow[];

  const update = jest.fn();
  const deleteFn = jest.fn();

  const emailFindFirst = jest.fn(
    ({
      where,
      select,
    }: {
      where: { publicId?: string; userId?: string; system?: boolean };
      select: Record<string, boolean>;
    }) => {
      const row = rows.find(
        (candidate) =>
          (where.publicId === undefined ||
            candidate.publicId === where.publicId) &&
          // Le filtre de propriété est appliqué par le double, comme
          // PostgreSQL l'appliquerait : une ligne d'un autre compte n'est
          // simplement pas rendue.
          (where.userId === undefined || candidate.userId === where.userId) &&
          (where.system === undefined || candidate.system === where.system),
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
      controllers: [EmailsLogController],
      providers: [
        EmailsLogService,
        SessionAuthGuard,
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
            email: {
              findFirst: emailFindFirst,
              findMany: jest.fn(() => Promise.resolve([])),
              count: jest.fn(() => Promise.resolve(0)),
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
        publicId: 'em_a',
        userId: userA.id,
        system: false,
        fromAddress: 'contact@zendou.gn',
        toAddress: 'client@example.gn',
        subject: 'Facture',
        status: EmailStatus.SENT,
        channel: EmailChannel.API,
        queuedAt: new Date('2026-02-01T00:00:00.000Z'),
        sentAt: new Date('2026-02-01T00:00:01.000Z'),
        deliveredAt: null,
        lastEventAt: null,
        errorMessage: null,
        sesMessageId: null,
        smtpCredentialId: null,
      },
    ];
  });

  const detail = (publicId: string, token?: string) => {
    const call = request(app.getHttpServer()).get(`/v1/emails/${publicId}`);
    return token ? call.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`) : call;
  };

  it('rend le détail au propriétaire', async () => {
    const response = await detail('em_a', 'token-a');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('publicId', 'em_a');
  });

  it('rend 401 sans cookie de session', async () => {
    const response = await detail('em_a');

    expect(response.status).toBe(401);
    expect(emailFindFirst).not.toHaveBeenCalled();
  });

  it('rend à un autre compte exactement le 404 d’un identifiant inexistant', async () => {
    const foreign = await detail('em_a', 'token-b');
    const missing = await detail('em_inexistant', 'token-a');

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    // Corps strictement identique : rien ne distingue « ça existe mais ce
    // n'est pas à vous » de « ça n'existe pas ». Aucune énumération possible.
    expect(foreign.body).toEqual(missing.body);
  });

  it('n’écrit rien en base sur la tentative inter-comptes', async () => {
    await detail('em_a', 'token-b');

    expect(update).not.toHaveBeenCalled();
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('filtre la requête sur le propriétaire, pas seulement la réponse', async () => {
    await detail('em_a', 'token-b');

    const [args] = emailFindFirst.mock.calls[0];

    // La propriété est établie dans la requête, pas après coup en JavaScript.
    expect(args.where).toEqual({
      publicId: 'em_a',
      userId: userB.id,
      system: false,
    });
  });
});

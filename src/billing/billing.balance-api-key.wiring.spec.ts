import { getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { SESSION_COOKIE_NAME, SESSION_REDIS, SessionService } from '../auth';
import { AllExceptionsFilter } from '../common/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import { RATE_LIMIT_REDIS } from '../rate-limit/rate-limit.constants';
import { ReputationService } from '../reputation';
import { BillingModule } from './billing.module';

/** Double de `ioredis` pour le compteur d'échecs : jamais bloquant ici. */
class FakeThrottleRedis {
  defineCommand(name: string): void {
    (this as unknown as Record<string, unknown>)[name] = (): Promise<
      [number, number, number, number]
    > => Promise.resolve([1, 60_000, 0, 0]);
  }

  disconnect(): void {
    // Aucune socket ouverte.
  }
}

const userRecord = {
  id: 'user_1',
  email: 'aissatou@exemple.gn',
  name: 'Aïssatou',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const prisma = {
  apiKey: { findUnique: jest.fn(), update: jest.fn() },
  user: { findUnique: jest.fn(), updateMany: jest.fn() },
  creditEntry: { aggregate: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  topUpRequest: { findMany: jest.fn() },
};

const sessionService = { resolve: jest.fn(), destroy: jest.fn() };

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
 * `GET /v1/billing/balance` accepte une clé API en plus de la session, et le
 * reste de `billing` reste session seulement. Vérifié avec le **vrai**
 * `BillingModule` (garde câblé tel qu'en production) : seules la base, la file
 * et Redis sont doublés.
 */
describe('Facturation - solde lisible par clé API (câblage réel)', () => {
  let app: NestExpressApplication;

  const KEY = `zd_live_${'a'.repeat(43)}`;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [InfrastructureDoubleModule, BillingModule],
    })
      .overrideProvider(getQueueToken(EMAIL_SEND_QUEUE))
      .useValue({ add: jest.fn() })
      .overrideProvider(RATE_LIMIT_REDIS)
      .useValue(new FakeThrottleRedis())
      .overrideProvider(SESSION_REDIS)
      .useValue({ disconnect: jest.fn() })
      .overrideProvider(SessionService)
      .useValue(sessionService)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.use(cookieParser());
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.apiKey.findUnique.mockResolvedValue(null);
    prisma.apiKey.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue(userRecord);
    prisma.creditEntry.aggregate.mockResolvedValue({ _sum: { delta: 120 } });
    prisma.creditEntry.findMany.mockResolvedValue([]);
    prisma.creditEntry.count.mockResolvedValue(0);
    sessionService.resolve.mockResolvedValue(null);
  });

  const activeKey = () =>
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'key_1',
      revokedAt: null,
      user: userRecord,
    });

  it('répond 200 avec le solde pour une clé API valide', async () => {
    activeKey();

    const response = await request(app.getHttpServer())
      .get('/v1/billing/balance')
      .set('Authorization', `Bearer ${KEY}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      balance: 120,
      totalPurchased: 120,
      totalGifted: 120,
      totalConsumed: 120,
    });
    const [firstCall] = prisma.creditEntry.aggregate.mock.calls[0] as [
      { where: { userId: string } },
    ];
    expect(firstCall.where.userId).toBe('user_1');
  });

  it('répond 200 pour une clé sans permission de lecture : le solde reste lisible par toute clé active', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'key_1',
      revokedAt: null,
      canRead: false,
      user: userRecord,
    });

    const response = await request(app.getHttpServer())
      .get('/v1/billing/balance')
      .set('Authorization', `Bearer ${KEY}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ balance: 120 });
  });

  it('répond 401 pour une clé inconnue', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/billing/balance')
      .set('Authorization', `Bearer ${KEY}`);

    expect(response.status).toBe(401);
    expect(prisma.creditEntry.aggregate).not.toHaveBeenCalled();
  });

  it('répond 401 pour une clé révoquée', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'key_1',
      revokedAt: new Date('2026-02-01T00:00:00.000Z'),
      user: userRecord,
    });

    const response = await request(app.getHttpServer())
      .get('/v1/billing/balance')
      .set('Authorization', `Bearer ${KEY}`);

    expect(response.status).toBe(401);
    expect(prisma.creditEntry.aggregate).not.toHaveBeenCalled();
  });

  it('continue de servir la session, comme avant', async () => {
    sessionService.resolve.mockResolvedValue('user_1');

    const response = await request(app.getHttpServer())
      .get('/v1/billing/balance')
      .set('Cookie', `${SESSION_COOKIE_NAME}=jeton`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ balance: 120 });
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('répond 401 sans session ni clé', async () => {
    const response = await request(app.getHttpServer()).get(
      '/v1/billing/balance',
    );

    expect(response.status).toBe(401);
  });

  it.each([
    '/v1/billing/entries',
    '/v1/billing/packs',
    '/v1/billing/payment-methods',
    '/v1/billing/topup-requests',
  ])(
    'refuse une clé API, même valide, sur %s (session seulement)',
    async (url) => {
      activeKey();

      const response = await request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${KEY}`);

      expect(response.status).toBe(401);
      expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
    },
  );
});

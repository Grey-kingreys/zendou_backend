import { getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { CredentialDomainScope, UserRole, UserStatus } from '@prisma/client';
import request from 'supertest';
import { SESSION_REDIS } from '../auth';
import { AllExceptionsFilter } from '../common/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import { RATE_LIMIT_REDIS } from '../rate-limit/rate-limit.constants';
import { ReputationService } from '../reputation';
import { EmailSendProcessor } from './email-send.processor';
import { EmailsModule } from './emails.module';

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

const KEY = `zd_live_${'a'.repeat(43)}`;

const userRecord = {
  id: 'user_1',
  email: 'aissatou@exemple.gn',
  name: 'Aïssatou',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const prisma = {
  apiKey: { findUnique: jest.fn(), update: jest.fn() },
  user: { findUnique: jest.fn() },
  domain: { findFirst: jest.fn() },
  suppression: { findFirst: jest.fn() },
  creditEntry: { aggregate: jest.fn(), create: jest.fn() },
  email: { create: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
};
const queue = { add: jest.fn() };

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
 * Portée par domaine d'une clé API (B27), vérifiée **câblée comme en
 * production** : le vrai `EmailsModule` (donc le vrai `ApiKeyAuthGuard`, le
 * vrai `EmailsController` et le vrai `EmailsService`) reçoit une vraie requête
 * HTTP. Seules la base, la file et Redis sont doublés. C'est ce montage qui
 * prouve que l'identifiant de clé posé par le garde atteint réellement le
 * contrôle de portée du point d'acceptation.
 */
describe('Portée par domaine d’une clé API (câblage réel via POST /v1/emails)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [InfrastructureDoubleModule, EmailsModule],
    })
      .overrideProvider(getQueueToken(EMAIL_SEND_QUEUE))
      .useValue(queue)
      .overrideProvider(EmailSendProcessor)
      .useValue({})
      .overrideProvider(RATE_LIMIT_REDIS)
      .useValue(new FakeThrottleRedis())
      .overrideProvider(SESSION_REDIS)
      .useValue({ disconnect: jest.fn() })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  /** La clé telle que la voit le garde (par empreinte) puis le contrôle de portée. */
  function givenKey(scope: {
    domainScope: CredentialDomainScope;
    domains: { domain: { id: string; name: string } }[];
  }): void {
    prisma.apiKey.findUnique.mockImplementation(
      ({ select }: { select: Record<string, unknown> }) =>
        Promise.resolve(
          'user' in select
            ? { id: 'key_1', revokedAt: null, user: userRecord }
            : scope,
        ),
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.apiKey.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({
      ...userRecord,
      dailySendLimit: 200,
      lastActivityAt: null,
      lowBalanceAlertSentAt: null,
    });
    prisma.domain.findFirst.mockResolvedValue({ id: 'dom_1' });
    prisma.suppression.findFirst.mockResolvedValue(null);
    prisma.creditEntry.aggregate.mockResolvedValue({ _sum: { delta: 10 } });
    prisma.creditEntry.create.mockResolvedValue({});
    prisma.email.count.mockResolvedValue(0);
    prisma.email.create.mockResolvedValue({ id: 'email_1', publicId: 'e_1' });
    prisma.$transaction.mockImplementation(
      (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
    );
    queue.add.mockResolvedValue({ id: 'job_1' });
  });

  const send = () =>
    request(app.getHttpServer())
      .post('/v1/emails')
      .set('Authorization', `Bearer ${KEY}`)
      .send({
        from: 'contact@boutique-awa.gn',
        to: 'client@exemple.gn',
        subject: 'Bonjour',
        html: '<p>Bonjour</p>',
      });

  it('accepte (202) une clé ALL', async () => {
    givenKey({ domainScope: CredentialDomainScope.ALL, domains: [] });

    const response = await send();

    expect(response.status).toBe(202);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('accepte (202) une clé SELECTED dont le domaine fait partie de la portée', async () => {
    givenKey({
      domainScope: CredentialDomainScope.SELECTED,
      domains: [{ domain: { id: 'dom_1', name: 'boutique-awa.gn' } }],
    });

    const response = await send();

    expect(response.status).toBe(202);
  });

  it('refuse (403) une clé SELECTED hors portée, en nommant le domaine autorisé (contrat G1)', async () => {
    givenKey({
      domainScope: CredentialDomainScope.SELECTED,
      domains: [{ domain: { id: 'dom_2', name: 'autre-marque.gn' } }],
    });

    const response = await send();
    const body = response.body as { message: string; errors: string[] };

    expect(response.status).toBe(403);
    expect(body.message).toBe(
      "Cette clé API n'est autorisée que pour le domaine autre-marque.gn.",
    );
    expect(body.errors).toEqual([body.message]);
    expect(body.message).toBe(body.errors.join(' '));
    expect(prisma.email.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuse (403) une clé SELECTED sans aucune ligne de jointure', async () => {
    givenKey({ domainScope: CredentialDomainScope.SELECTED, domains: [] });

    const response = await send();

    expect(response.status).toBe(403);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

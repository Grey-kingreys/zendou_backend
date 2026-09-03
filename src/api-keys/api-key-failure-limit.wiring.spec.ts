import { createHash } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { SESSION_REDIS } from '../auth';
import { AllExceptionsFilter } from '../common/http-exception.filter';
import { EmailSendProcessor } from '../emails/email-send.processor';
import { EmailsModule } from '../emails/emails.module';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import {
  RATE_LIMIT_REDIS,
  TOO_MANY_REQUESTS_MESSAGE,
} from '../rate-limit/rate-limit.constants';
import { trustProxySetting } from '../rate-limit/rate-limit.identity';
import { ReputationService } from '../reputation';
import {
  API_KEY_FAILURE_KEY_PREFIX,
  API_KEY_FAILURES_PER_MINUTE_DEFAULT,
} from './api-keys.constants';

/**
 * Double de `ioredis` limité à ce dont `RedisThrottlerStorage` se sert :
 * `defineCommand`, puis la commande ainsi définie. Il reproduit la sémantique
 * du script Lua (blocage quand `hits > limit`, plus d'incrément une fois
 * bloqué), ce qui laisse le vrai `RedisThrottlerStorage` faire son travail -
 * préfixe de clé et conversion en secondes comprises.
 */
class FakeThrottleRedis {
  private readonly hits = new Map<string, number>();
  private readonly blocked = new Set<string>();
  readonly keys: string[] = [];

  /**
   * `RedisThrottlerStorage` passe aussi la définition du script Lua ; ce
   * double n'en a pas l'usage et ne déclare donc pas le paramètre.
   */
  defineCommand(name: string): void {
    (this as unknown as Record<string, unknown>)[name] = (
      hitsKey: string,
      _blockKey: string,
      ttl: string,
      limit: string,
      blockDuration: string,
    ): Promise<[number, number, number, number]> => {
      this.keys.push(hitsKey);

      if (this.blocked.has(hitsKey)) {
        return Promise.resolve([
          this.hits.get(hitsKey) ?? 0,
          Number(ttl),
          1,
          Number(blockDuration),
        ]);
      }

      const total = (this.hits.get(hitsKey) ?? 0) + 1;
      this.hits.set(hitsKey, total);

      if (total > Number(limit)) {
        this.blocked.add(hitsKey);
        return Promise.resolve([total, Number(ttl), 1, Number(blockDuration)]);
      }

      return Promise.resolve([total, Number(ttl), 0, 0]);
    };
  }

  disconnect(): void {
    // Rien à fermer : aucune socket n'a jamais été ouverte.
  }
}

const prisma = {
  apiKey: { findUnique: jest.fn(), update: jest.fn() },
  user: { findUnique: jest.fn() },
};

const configService = { get: jest.fn(() => undefined) };

/**
 * `PrismaModule`, `ConfigModule` et `ReputationModule` sont globaux dans
 * l'application ; ils le sont donc aussi ici, doublés, pour que le graphe réel
 * d'`EmailsModule` se monte sans base ni Redis.
 */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: ConfigService, useValue: configService },
    { provide: ReputationService, useValue: {} },
  ],
  exports: [PrismaService, ConfigService, ReputationService],
})
class InfrastructureDoubleeModule {}

/**
 * Câblage de la limite d'échecs par clé API (lot C), vérifié **là où le garde
 * est réellement posé**.
 *
 * Le défaut que ce test verrouille : `ApiKeyAuthGuard` est déclaré par
 * `ApiKeysModule` mais posé par `@UseGuards(...)` sur `EmailsController`, que
 * déclare `EmailsModule`. Nest reconstruit l'enhancer dans le contexte de ce
 * dernier ; tant que `ApiKeysModule` n'y réexportait pas
 * `RateLimitCoreModule`, `RedisThrottlerStorage` n'y était pas visible. En
 * production, la limite ne se déclenchait donc jamais : 30 clés invalides
 * d'affilée rendaient 30 fois 401 et aucune clé de compteur n'apparaissait
 * dans Redis.
 *
 * Les tests unitaires du garde ne pouvaient pas le voir : ils lui injectaient
 * le stockage directement, prouvant la logique de comptage et jamais son
 * câblage. Celui-ci monte donc le **vrai** `EmailsModule` (qui importe le vrai
 * `ApiKeysModule`), et ne double que les feuilles qui parlent au monde
 * extérieur : la base, la file, et les deux clients Redis.
 */
describe('Limite d’échecs par clé API - câblage réel via EmailsController', () => {
  let app: NestExpressApplication;
  let redis: FakeThrottleRedis;

  const CLIENT_IP = '41.223.10.5';
  const INVALID_KEY = `zd_live_${'z'.repeat(43)}`;

  beforeAll(async () => {
    redis = new FakeThrottleRedis();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [InfrastructureDoubleeModule, EmailsModule],
    })
      // Feuilles remplacées : aucune socket, aucun worker BullMQ.
      .overrideProvider(getQueueToken(EMAIL_SEND_QUEUE))
      .useValue({ add: jest.fn() })
      .overrideProvider(EmailSendProcessor)
      .useValue({})
      .overrideProvider(RATE_LIMIT_REDIS)
      .useValue(redis)
      .overrideProvider(SESSION_REDIS)
      .useValue({ disconnect: jest.fn() })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    // Comme en production : sans `trust proxy`, Express ignore
    // `X-Forwarded-For` et tous les clients derrière le proxy partageraient le
    // compteur de l'adresse du proxy.
    app.set('trust proxy', trustProxySetting(1));
    app.setGlobalPrefix('v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // Clé inconnue : chaque requête est un échec d'authentification.
    prisma.apiKey.findUnique.mockResolvedValue(null);
  });

  const send = () =>
    request(app.getHttpServer())
      .post('/v1/emails')
      .set('Authorization', `Bearer ${INVALID_KEY}`)
      .set('X-Forwarded-For', CLIENT_IP)
      .send({ from: 'a@b.gn', to: 'c@d.gn', subject: 's', html: '<p>x</p>' });

  it('compte les échecs et répond 429 à la 21e clé invalide, Retry-After compris', async () => {
    for (
      let attempt = 1;
      attempt <= API_KEY_FAILURES_PER_MINUTE_DEFAULT;
      attempt++
    ) {
      const response = await send();
      expect(response.status).toBe(401);
    }

    const blocked = await send();

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      error: 'Too Many Requests',
      message: TOO_MANY_REQUESTS_MESSAGE,
      retryAfter: 60,
    });
  });

  it('a réellement écrit dans le compteur partagé, sous l’empreinte de l’IP', async () => {
    await send();

    // La preuve directe de ce qui manquait : sans le câblage, aucune clé
    // `throttle:apikey-fail:*` n'était jamais touchée.
    const ipHash = createHash('sha256').update(CLIENT_IP).digest('hex');
    const expected = `throttle:${API_KEY_FAILURE_KEY_PREFIX}${ipHash}`;

    expect(redis.keys.length).toBeGreaterThan(0);
    expect(new Set(redis.keys)).toEqual(new Set([expected]));
    // L'IP n'entre jamais en clair dans la clé du compteur.
    expect(expected).not.toContain(CLIENT_IP);
  });
});

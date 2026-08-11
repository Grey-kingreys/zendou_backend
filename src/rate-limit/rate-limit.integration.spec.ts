import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { INVALID_CREDENTIALS_MESSAGE } from '../auth/auth.constants';
import { SessionService } from '../auth/session.service';
import { HealthController } from '../health/health.controller';
import { HealthService } from '../health/health.service';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitPolicyService } from './rate-limit-policy.service';
import { RateLimitTrackerService } from './rate-limit-tracker.service';
import {
  RATE_LIMIT_DEFAULTS,
  TOO_MANY_REQUESTS_MESSAGE,
} from './rate-limit.constants';
import { RateLimitGuard } from './rate-limit.guard';
import { buildThrottlerOptions } from './rate-limit.options';

/**
 * Test d'intégration de bout en bout de la couche de limitation : vraies
 * routes, vrais décorateurs, vrai garde, vraie pile Express (donc vraie
 * résolution de `X-Forwarded-For`).
 *
 * Le stockage est celui, en mémoire, fourni par la bibliothèque : ce test
 * vérifie la *politique*, pas le script Lua — ce dernier est couvert par
 * `redis-throttler.storage.spec.ts` et par la démonstration sur Redis réel.
 */
describe('Limitation de débit (intégration)', () => {
  let app: NestExpressApplication;
  let storage: ThrottlerStorageService;

  const PROXY_IP = '203.0.113.10';
  const OTHER_PROXY_IP = '198.51.100.20';

  beforeAll(async () => {
    storage = new ThrottlerStorageService();

    const configStub = {
      get: () => undefined,
    } as unknown as ConfigService;

    const sessionStub = {
      peek: jest.fn().mockResolvedValue(null),
      destroy: jest.fn().mockResolvedValue(undefined),
    } as unknown as SessionService;

    const policyService = new RateLimitPolicyService(configStub);
    const trackerService = new RateLimitTrackerService(sessionStub);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot(
          buildThrottlerOptions(policyService, trackerService, storage),
        ),
      ],
      controllers: [AuthController, HealthController],
      providers: [
        { provide: RateLimitPolicyService, useValue: policyService },
        { provide: RateLimitTrackerService, useValue: trackerService },
        { provide: ConfigService, useValue: configStub },
        { provide: SessionService, useValue: sessionStub },
        { provide: PrismaService, useValue: {} },
        {
          provide: AuthService,
          useValue: {
            // Toute tentative échoue : on mesure la limitation, pas la
            // vérification du mot de passe.
            login: jest
              .fn()
              .mockRejectedValue(
                new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE),
              ),
          },
        },
        {
          provide: HealthService,
          useValue: {
            check: jest
              .fn()
              .mockResolvedValue({ status: 'ok', db: 'ok', redis: 'ok' }),
          },
        },
        { provide: APP_GUARD, useClass: RateLimitGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    // Comme en production derrière Dokploy/Traefik : l'IP retenue est celle
    // écrite par le proxy dans `X-Forwarded-For`, pas celle de la socket.
    app.set('trust proxy', 1);
    app.setGlobalPrefix('v1', { exclude: ['health'] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    // Le stockage en mémoire arme un timer par requête comptée.
    storage.onApplicationShutdown();
  });

  const login = (ip: string, email: string) =>
    request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'mauvais-mot-de-passe' });

  it('répond 429 à la N+1ᵉ tentative de connexion, avec Retry-After', async () => {
    const email = 'cible@example.com';
    const limit = RATE_LIMIT_DEFAULTS.LOGIN_PER_MINUTE;

    for (let attempt = 1; attempt <= limit; attempt++) {
      const response = await login(PROXY_IP, email);
      expect(response.status).toBe(401);
    }

    const blocked = await login(PROXY_IP, email);

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      message: TOO_MANY_REQUESTS_MESSAGE,
    });
  });

  it("repart d'un compteur neuf derrière une autre IP réelle", async () => {
    // Preuve que c'est bien `X-Forwarded-For` qui identifie le client : à IP
    // de socket identique (127.0.0.1 pour tout le monde ici), un autre client
    // déclaré n'hérite pas du blocage du précédent.
    const response = await login(OTHER_PROXY_IP, 'quelquun-dautre@example.com');

    expect(response.status).toBe(401);
  });

  it("garde l'IP bloquée même pour une autre adresse email", async () => {
    const response = await login(PROXY_IP, 'encore-un-autre@example.com');

    expect(response.status).toBe(429);
  });

  it("garde l'email bloqué même depuis une autre IP", async () => {
    // Le compteur par identifiant visé fait son travail : changer d'IP ne
    // suffit pas à reprendre le bourrinage d'un compte donné.
    const response = await login(OTHER_PROXY_IP, 'cible@example.com');

    expect(response.status).toBe(429);
  });

  it('renvoie le même message que le compte existe ou non', async () => {
    const inconnu = await login(PROXY_IP, 'inexistant@example.com');
    const connu = await login(PROXY_IP, 'cible@example.com');

    const messageDe = (response: { body: unknown }) =>
      (response.body as { message?: string }).message;

    expect(inconnu.status).toBe(429);
    expect(connu.status).toBe(429);
    expect(messageDe(inconnu)).toBe(messageDe(connu));
    expect(messageDe(inconnu)).toBe(TOO_MANY_REQUESTS_MESSAGE);
  });

  it('laisse passer /health indéfiniment', async () => {
    // Le HEALTHCHECK Docker frappe cette route en boucle : au-delà du budget
    // global (120/min) elle doit toujours répondre 200, sinon le conteneur
    // basculerait en unhealthy.
    const calls = RATE_LIMIT_DEFAULTS.DEFAULT_PER_MINUTE + 10;

    for (let i = 0; i < calls; i++) {
      const response = await request(app.getHttpServer())
        .get('/health')
        .set('X-Forwarded-For', PROXY_IP);

      expect(response.status).toBe(200);
    }
  });
});

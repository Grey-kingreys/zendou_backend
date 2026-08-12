import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { EmailConfirmationService } from '../auth/email-confirmation.service';
import { SessionService } from '../auth/session.service';
import { PrismaService } from '../prisma/prisma.service';
import { CAPTCHA_FAILED_MESSAGE } from './captcha.constants';
import { CaptchaGuard } from './captcha.guard';
import { CaptchaService } from './captcha.service';

const VALID_TOKEN = 'valid-turnstile-token';
const REFUSED_TOKEN = 'refused-turnstile-token';
const TURNSTILE_SECRET = 'test-turnstile-secret';

const authUser = {
  id: 'user_1',
  email: 'demo-captcha-test@example.com',
  name: 'Démo Captcha',
  company: null,
  declaredUsage: null,
  role: 'CUSTOMER',
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Corps d'erreur NestJS typé, pour éviter l'accès `any` sur `response.body`. */
function messageOf(response: { body: unknown }): string | undefined {
  return (response.body as { message?: string }).message;
}

/**
 * Construit une application Nest minimale autour du vrai `AuthController`,
 * du vrai `CaptchaGuard` et de la vraie `CaptchaService` — `secretKey`
 * détermine, dès la construction (donc avant tout appel), si le captcha est
 * activé. `AuthService.register` est mocké : c'est le seul chemin vers
 * `prisma.user.create`, donc vérifier qu'il n'est **jamais appelé** prouve
 * que rien n'est écrit en base.
 */
async function buildApp(
  secretKey: string | undefined,
  registerMock: jest.Mock,
): Promise<NestExpressApplication> {
  const configGet = jest.fn((key: string) => {
    if (key === 'TURNSTILE_SECRET_KEY') return secretKey;
    if (key === 'NODE_ENV') return 'test';
    return undefined;
  });

  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: AuthService, useValue: { register: registerMock } },
      {
        provide: SessionService,
        useValue: { create: jest.fn(), resolve: jest.fn(), destroy: jest.fn() },
      },
      { provide: ConfigService, useValue: { get: configGet } },
      // Non utilisé par la route testée, mais requis par SessionAuthGuard
      // (posé sur d'autres routes du même contrôleur) pour que le module
      // compile.
      { provide: PrismaService, useValue: {} },
      // Idem : requis par le contrôleur (routes de confirmation), jamais
      // sollicité par la route testée.
      {
        provide: EmailConfirmationService,
        useValue: { confirm: jest.fn(), resend: jest.fn() },
      },
      CaptchaService,
      CaptchaGuard,
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  return app;
}

describe('POST /auth/register — captcha (intégration)', () => {
  let app: NestExpressApplication;
  let fetchMock: jest.Mock;
  let registerMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    registerMock = jest.fn().mockResolvedValue({
      user: authUser,
      token: 'session-token',
    });
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  describe('captcha désactivé (TURNSTILE_SECRET_KEY absente)', () => {
    beforeEach(async () => {
      app = await buildApp(undefined, registerMock);
    });

    it('inscription sans jeton acceptée (comportement inchangé)', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: authUser.email,
          password: 'motdepasse-solide',
          name: authUser.name,
        });

      expect(response.status).toBe(201);
      expect(registerMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ignore un captchaToken présent mais superflu', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: authUser.email,
          password: 'motdepasse-solide',
          name: authUser.name,
          captchaToken: 'jeton-quelconque',
        });

      expect(response.status).toBe(201);
      expect(registerMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('captcha activé (TURNSTILE_SECRET_KEY présente)', () => {
    beforeEach(async () => {
      app = await buildApp(TURNSTILE_SECRET, registerMock);
    });

    it('jeton valide (Cloudflare success:true) : inscription acceptée', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ success: true }));

      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: authUser.email,
          password: 'motdepasse-solide',
          name: authUser.name,
          captchaToken: VALID_TOKEN,
        });

      expect(response.status).toBe(201);
      expect(registerMock).toHaveBeenCalledTimes(1);
    });

    it('jeton absent : 400 français, rien écrit en base (register() jamais appelé)', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: authUser.email,
          password: 'motdepasse-solide',
          name: authUser.name,
        });

      expect(response.status).toBe(400);
      expect(messageOf(response)).toBe(CAPTCHA_FAILED_MESSAGE);
      expect(registerMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('jeton refusé par Cloudflare (success:false) : 400, rien écrit en base', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          success: false,
          'error-codes': ['invalid-input-response'],
        }),
      );

      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: authUser.email,
          password: 'motdepasse-solide',
          name: authUser.name,
          captchaToken: REFUSED_TOKEN,
        });

      expect(response.status).toBe(400);
      expect(messageOf(response)).toBe(CAPTCHA_FAILED_MESSAGE);
      expect(registerMock).not.toHaveBeenCalled();
    });

    it('Cloudflare injoignable/timeout : 400, rien écrit en base (échec fermé)', async () => {
      fetchMock.mockRejectedValue(new Error('timeout'));

      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: authUser.email,
          password: 'motdepasse-solide',
          name: authUser.name,
          captchaToken: VALID_TOKEN,
        });

      expect(response.status).toBe(400);
      expect(messageOf(response)).toBe(CAPTCHA_FAILED_MESSAGE);
      expect(registerMock).not.toHaveBeenCalled();
    });

    it('ni le secret ni le jeton ne fuient dans la réponse HTTP', async () => {
      fetchMock.mockRejectedValue(new Error('timeout'));

      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: authUser.email,
          password: 'motdepasse-solide',
          name: authUser.name,
          captchaToken: VALID_TOKEN,
        });

      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain(TURNSTILE_SECRET);
      expect(raw).not.toContain(VALID_TOKEN);
    });
  });
});

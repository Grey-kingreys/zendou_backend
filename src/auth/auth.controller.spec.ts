import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, Logger } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { UserRole, UserStatus } from '@prisma/client';
import type { Request, Response } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CaptchaService } from '../captcha/captcha.service';
import { RATE_LIMIT_POLICY } from '../rate-limit/rate-limit.constants';
import { RATE_LIMIT_POLICY_METADATA } from '../rate-limit/rate-limit.decorator';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from './auth.constants';
import {
  AuthController,
  SESSION_COOKIE_DOMAIN_MISSING_WARNING,
} from './auth.controller';
import { AuthService } from './auth.service';
import { AUTH_USER_SELECT, AuthUser } from './auth.types';
import { EmailConfirmationService } from './email-confirmation.service';
import { SessionAuthGuard } from './session-auth.guard';
import {
  baseSessionCookieOptions,
  sessionCookieOptions,
} from './session-cookie';
import { SessionService } from './session.service';

const authUser: AuthUser = {
  id: 'user_1',
  email: 'aissatou@example.com',
  name: 'Aïssatou Diallo',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

interface ResponseMock {
  response: Response;
  cookie: jest.Mock;
  clearCookie: jest.Mock;
}

function responseMock(): ResponseMock {
  const cookie = jest.fn();
  const clearCookie = jest.fn();

  return {
    response: { cookie, clearCookie } as unknown as Response,
    cookie,
    clearCookie,
  };
}

function requestMock(cookies?: Record<string, string>): Request {
  return { cookies } as unknown as Request;
}

describe('AuthController', () => {
  let controller: AuthController;

  const authService = {
    register: jest.fn(),
    login: jest.fn(),
    updateProfile: jest.fn(),
    changePassword: jest.fn(),
  };
  const sessionService = {
    create: jest.fn(),
    resolve: jest.fn(),
    destroy: jest.fn(),
  };
  const emailConfirmationService = {
    confirm: jest.fn(),
    resend: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: SessionService, useValue: sessionService },
        {
          provide: EmailConfirmationService,
          useValue: emailConfirmationService,
        },
        // Mock sensible à la clé : `SESSION_COOKIE_DOMAIN` doit pouvoir être
        // absente sans que le contrôleur reçoive la valeur de `NODE_ENV`.
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'NODE_ENV' ? 'development' : undefined,
            ),
          },
        },
        // Captcha désactivé (pas de TURNSTILE_SECRET_KEY) : suffit à
        // satisfaire les dépendances de CaptchaGuard, posé sur /register.
        // Son comportement est couvert par captcha.guard.spec.ts et
        // captcha-register.integration.spec.ts.
        { provide: CaptchaService, useValue: { isEnabled: false } },
      ],
    })
      // Le guard est couvert par session-auth.guard.spec.ts.
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('sets the session cookie on register and returns the public user', async () => {
    authService.register.mockResolvedValue({
      user: authUser,
      token: 'token-register',
    });
    const { response, cookie } = responseMock();

    await expect(
      controller.register(
        {
          email: 'aissatou@example.com',
          password: 'motdepasse-solide',
          name: 'Aïssatou Diallo',
        },
        response,
      ),
    ).resolves.toEqual(authUser);

    expect(cookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, 'token-register', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
  });

  it('sets the session cookie on login', async () => {
    authService.login.mockResolvedValue({
      user: authUser,
      token: 'token-login',
    });
    const { response, cookie } = responseMock();

    await expect(
      controller.login(
        { email: 'aissatou@example.com', password: 'motdepasse-solide' },
        response,
      ),
    ).resolves.toEqual(authUser);

    expect(cookie).toHaveBeenCalledWith(
      SESSION_COOKIE_NAME,
      'token-login',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    );
  });

  it('destroys the session and clears the cookie on logout', async () => {
    const { response, clearCookie } = responseMock();

    await controller.logout(
      requestMock({ [SESSION_COOKIE_NAME]: 'token-logout' }),
      response,
    );

    expect(sessionService.destroy).toHaveBeenCalledWith('token-logout');
    expect(clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
    });
  });

  it('is idempotent on logout without a session cookie', async () => {
    const { response, clearCookie } = responseMock();

    await expect(
      controller.logout(requestMock(), response),
    ).resolves.toBeUndefined();

    expect(sessionService.destroy).not.toHaveBeenCalled();
    expect(clearCookie).toHaveBeenCalledTimes(1);
  });

  it('returns the injected current user on /me', () => {
    expect(controller.me(authUser)).toEqual(authUser);
  });

  it('delegates PATCH /me to the service with the current user id', async () => {
    const updated = { ...authUser, name: 'Nouveau Nom' };
    authService.updateProfile.mockResolvedValue(updated);

    await expect(
      controller.updateMe(authUser, { name: 'Nouveau Nom' }),
    ).resolves.toEqual(updated);

    expect(authService.updateProfile).toHaveBeenCalledWith('user_1', {
      name: 'Nouveau Nom',
    });
  });

  it('revokes every session and clears the cookie on change-password', async () => {
    authService.changePassword.mockResolvedValue(undefined);
    const { response, clearCookie } = responseMock();

    await controller.changePassword(
      authUser,
      { currentPassword: 'ancien', newPassword: 'nouveau-mot-de-passe' },
      response,
    );

    expect(authService.changePassword).toHaveBeenCalledWith('user_1', {
      currentPassword: 'ancien',
      newPassword: 'nouveau-mot-de-passe',
    });
    expect(clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
    });
  });

  it('does not clear the cookie if change-password rejects', async () => {
    authService.changePassword.mockRejectedValue(new Error('nope'));
    const { response, clearCookie } = responseMock();

    await expect(
      controller.changePassword(
        authUser,
        { currentPassword: 'mauvais', newPassword: 'nouveau-mot-de-passe' },
        response,
      ),
    ).rejects.toThrow('nope');

    expect(clearCookie).not.toHaveBeenCalled();
  });

  describe('confirmation de l’adresse email', () => {
    it('POST /confirm-email délègue le jeton et répond 200', async () => {
      emailConfirmationService.confirm.mockResolvedValue({
        confirmed: true,
        creditsGranted: 1_000,
      });

      await expect(
        controller.confirmEmail({ token: 'jeton-en-clair' }),
      ).resolves.toEqual({ confirmed: true, creditsGranted: 1_000 });

      expect(emailConfirmationService.confirm).toHaveBeenCalledWith(
        'jeton-en-clair',
      );
    });

    it('POST /confirm-email est bien un 200 (contrat figé)', () => {
      const handler = Object.getOwnPropertyDescriptor(
        AuthController.prototype,
        'confirmEmail',
      )?.value as (...args: unknown[]) => unknown;

      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
        HttpStatus.OK,
      );
    });

    it('POST /resend-confirmation délègue l’identifiant de session', async () => {
      emailConfirmationService.resend.mockResolvedValue({ sent: true });

      await expect(controller.resendConfirmation(authUser)).resolves.toEqual({
        sent: true,
      });

      expect(emailConfirmationService.resend).toHaveBeenCalledWith('user_1');
    });

    it('POST /resend-confirmation répond 202 (accepté, pas encore remis)', () => {
      const handler = Object.getOwnPropertyDescriptor(
        AuthController.prototype,
        'resendConfirmation',
      )?.value as (...args: unknown[]) => unknown;

      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
        HttpStatus.ACCEPTED,
      );
    });

    it('le renvoi porte une politique de limitation dédiée, comptée par utilisateur', () => {
      const handler = Object.getOwnPropertyDescriptor(
        AuthController.prototype,
        'resendConfirmation',
      )?.value as (...args: unknown[]) => unknown;

      expect(Reflect.getMetadata(RATE_LIMIT_POLICY_METADATA, handler)).toBe(
        RATE_LIMIT_POLICY.RESEND_CONFIRMATION,
      );
    });

    it('GET /me expose emailVerifiedAt', () => {
      expect(AUTH_USER_SELECT).toHaveProperty('emailVerifiedAt', true);
      expect(
        controller.me({ ...authUser, emailVerifiedAt: null }),
      ).toHaveProperty('emailVerifiedAt', null);
    });

    /**
     * V11D : `testSenderAddress` n'est pas une colonne Prisma, donc il n'a
     * pas sa place dans `AUTH_USER_SELECT` (voir `auth.types.ts`) — à la
     * différence du test ci-dessus pour `emailVerifiedAt`. Le contrôleur ne
     * fait que transmettre ce que `SessionAuthGuard`/`AuthService` lui
     * donnent ; la construction réelle de la valeur est couverte par
     * `auth.service.spec.ts` (describe `testSenderAddress (V11D)`) et
     * `session-auth.guard.spec.ts`. Ce test vérifie seulement le contrat
     * d'API des deux routes qui renvoient un `AuthUser` complet.
     */
    it('GET /me expose testSenderAddress', () => {
      expect(
        controller.me({
          ...authUser,
          testSenderAddress: 'test@mail.kingreys.fr',
        }),
      ).toHaveProperty('testSenderAddress', 'test@mail.kingreys.fr');
    });

    it('PATCH /me expose aussi testSenderAddress (même contrat que GET)', async () => {
      authService.updateProfile.mockResolvedValue({
        ...authUser,
        testSenderAddress: 'test@mail.kingreys.fr',
      });

      await expect(
        controller.updateMe(authUser, { name: authUser.name }),
      ).resolves.toHaveProperty('testSenderAddress', 'test@mail.kingreys.fr');
    });
  });
});

describe('session cookie options', () => {
  it('marks the cookie secure only in production', () => {
    expect(sessionCookieOptions(false).secure).toBe(false);
    expect(sessionCookieOptions(true).secure).toBe(true);
    expect(baseSessionCookieOptions(true)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
    });
  });

  it('n’ajoute aucun attribut domain quand SESSION_COOKIE_DOMAIN est absente', () => {
    expect(baseSessionCookieOptions(true)).not.toHaveProperty('domain');
    expect(sessionCookieOptions(true)).not.toHaveProperty('domain');
    expect(baseSessionCookieOptions(true, '')).not.toHaveProperty('domain');
  });

  it('ajoute domain quand SESSION_COOKIE_DOMAIN est configurée', () => {
    expect(baseSessionCookieOptions(true, 'zendou.app')).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
      domain: 'zendou.app',
    });
    expect(sessionCookieOptions(false, 'zendou.app')).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
      domain: 'zendou.app',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
  });
});

/**
 * Lot D - preuve au niveau HTTP réel (et pas seulement sur un double de
 * `Response`) : c'est l'en-tête `Set-Cookie` que le navigateur lit, donc c'est
 * lui qu'on inspecte. Application Nest réelle, contrôleur réel, requêtes
 * supertest - même patron qu'`admin-stats.controller.spec.ts`.
 */
describe('AuthController - attribut Domain du cookie de session (lot D)', () => {
  const authService = {
    register: jest.fn(),
    login: jest.fn(),
    updateProfile: jest.fn(),
    changePassword: jest.fn(),
  };
  const sessionService = { destroy: jest.fn() };
  const emailConfirmationService = { confirm: jest.fn(), resend: jest.fn() };

  async function buildApp(
    values: Record<string, string | undefined>,
  ): Promise<INestApplication<App>> {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: SessionService, useValue: sessionService },
        {
          provide: EmailConfirmationService,
          useValue: emailConfirmationService,
        },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => values[key] },
        },
        { provide: CaptchaService, useValue: { isEnabled: false } },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const app = module.createNestApplication<INestApplication<App>>();
    await app.init();
    return app;
  }

  function setCookies(headers: Record<string, unknown>): string[] {
    const raw = headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    authService.login.mockResolvedValue({
      user: authUser,
      token: 'token-login',
    });
  });

  it('pose Domain=zendou.app à la connexion quand la variable est configurée', async () => {
    const app = await buildApp({ SESSION_COOKIE_DOMAIN: 'zendou.app' });

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'aissatou@example.com', password: 'motdepasse-solide' });

    expect(response.status).toBe(200);
    const cookies = setCookies(response.headers);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('Domain=zendou.app');

    await app.close();
  });

  it('ne pose jamais d’attribut Domain quand la variable est absente', async () => {
    const app = await buildApp({});

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'aissatou@example.com', password: 'motdepasse-solide' });

    expect(response.status).toBe(200);
    const cookies = setCookies(response.headers);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).not.toContain('Domain=');

    await app.close();
  });

  it('la déconnexion émet deux Set-Cookie d’effacement quand le domaine est configuré', async () => {
    const app = await buildApp({ SESSION_COOKIE_DOMAIN: 'zendou.app' });

    const response = await request(app.getHttpServer()).post('/auth/logout');

    expect(response.status).toBe(204);
    const cookies = setCookies(response.headers);
    expect(cookies).toHaveLength(2);
    // Le cookie posé depuis le déploiement…
    expect(cookies.some((cookie) => cookie.includes('Domain=zendou.app'))).toBe(
      true,
    );
    // …et celui, hôte-seul, des sessions ouvertes avant lui.
    expect(cookies.some((cookie) => !cookie.includes('Domain='))).toBe(true);
    expect(
      cookies.every((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=;`)),
    ).toBe(true);

    await app.close();
  });

  it('n’émet qu’un seul Set-Cookie d’effacement quand aucun domaine n’est configuré', async () => {
    const app = await buildApp({});

    const response = await request(app.getHttpServer()).post('/auth/logout');

    expect(response.status).toBe(204);
    expect(setCookies(response.headers)).toHaveLength(1);

    await app.close();
  });

  it('avertit au démarrage quand la variable manque en production', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const app = await buildApp({ NODE_ENV: 'production' });

    expect(warn).toHaveBeenCalledWith(SESSION_COOKIE_DOMAIN_MISSING_WARNING);

    await app.close();
    warn.mockRestore();
  });

  it('n’avertit pas quand la variable est présente en production', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const app = await buildApp({
      NODE_ENV: 'production',
      SESSION_COOKIE_DOMAIN: 'zendou.app',
    });

    expect(warn).not.toHaveBeenCalledWith(
      SESSION_COOKIE_DOMAIN_MISSING_WARNING,
    );

    await app.close();
    warn.mockRestore();
  });
});

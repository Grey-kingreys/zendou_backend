import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { setupApp } from '../app-setup';
import { CREDIT_REASON_WELCOME_BONUS } from '../billing/billing.constants';
import { CaptchaService } from '../captcha/captcha.service';
import { EmailsService } from '../emails/emails.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  PASSWORD_NOT_SET_CODE,
  PASSWORD_NOT_SET_LOGIN_MESSAGE,
  SESSION_COOKIE_NAME,
  SESSION_REDIS,
} from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailConfirmationService } from './email-confirmation.service';
import { GoogleAuthController } from './google-auth.controller';
import {
  GOOGLE_DISABLED_MESSAGE,
  GOOGLE_STATE_COOKIE_NAME,
} from './google-oauth.constants';
import { GoogleOAuthService } from './google-oauth.service';
import { LoginLockoutService } from './login-lockout.service';
import { SessionService } from './session.service';

// `argon2.verify` enveloppé (comportement réel conservé) pour prouver qu'un
// compte sans mot de passe ne déclenche aucune vérification argon2.
jest.mock('argon2', () => {
  const actual: typeof argon2 = jest.requireActual('argon2');
  return {
    ...actual,
    verify: jest.fn((...args: Parameters<typeof actual.verify>) =>
      actual.verify(...args),
    ),
  };
});

/**
 * Parcours « Continuer avec Google » (B30) de bout en bout, à travers HTTP :
 * vrais contrôleurs, vrais `GoogleOAuthService`, `AuthService`,
 * `SessionService`, `EmailConfirmationService`, `LoginLockoutService` et
 * `SessionAuthGuard`, montés par `setupApp` comme en production. Seuls
 * changent : Redis et Prisma (doubles en mémoire à sémantique réelle), et
 * `fetch` (l'endpoint de jeton de Google, simulé).
 */

const CLIENT_ID = 'client-id-de-test.apps.googleusercontent.com';
const CLIENT_SECRET = 'secret-client-de-test';
const APP_BASE_URL = 'https://app.zendou.test';
const COOKIE_DOMAIN = 'zendou.test';
const WELCOME_CREDITS = 1000;
const AUTH_CODE = 'code-autorisation-de-test';

// ─── Redis en mémoire ───

class FakeRedis {
  readonly store = new Map<string, string | Set<string>>();
  readonly ttls = new Map<string, number>();

  set(key: string, value: string, _ex?: string, ttl?: number) {
    this.store.set(key, value);
    if (ttl !== undefined) this.ttls.set(key, ttl);
    return Promise.resolve('OK');
  }

  get(key: string) {
    const value = this.store.get(key);
    return Promise.resolve(typeof value === 'string' ? value : null);
  }

  del(...keys: string[]) {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count += 1;
      this.ttls.delete(key);
    }
    return Promise.resolve(count);
  }

  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const chain = {
      get: (key: string) => {
        ops.push(() => this.get(key));
        return chain;
      },
      del: (key: string) => {
        ops.push(() => this.del(key));
        return chain;
      },
      exec: async () => {
        const results: Array<[null, unknown]> = [];
        for (const op of ops) results.push([null, await op()]);
        return results;
      },
    };
    return chain;
  }

  sadd(key: string, member: string) {
    const current = this.store.get(key);
    const set = current instanceof Set ? current : new Set<string>();
    set.add(member);
    this.store.set(key, set);
    return Promise.resolve(1);
  }

  srem(key: string, member: string) {
    const current = this.store.get(key);
    if (current instanceof Set) current.delete(member);
    return Promise.resolve(1);
  }

  smembers(key: string) {
    const current = this.store.get(key);
    return Promise.resolve(current instanceof Set ? [...current] : []);
  }

  expire(key: string, ttl: number) {
    this.ttls.set(key, ttl);
    return Promise.resolve(1);
  }

  ttl(key: string) {
    return Promise.resolve(
      this.store.has(key) ? (this.ttls.get(key) ?? -1) : -2,
    );
  }

  incr(key: string) {
    const next = Number(this.store.get(key) ?? 0) + 1;
    this.store.set(key, String(next));
    return Promise.resolve(next);
  }
}

// ─── Prisma en mémoire (User + CreditEntry) ───

interface UserRow {
  id: string;
  email: string;
  passwordHash: string | null;
  name: string;
  company: string | null;
  declaredUsage: string | null;
  role: UserRole;
  status: UserStatus;
  dailySendLimit: number;
  emailVerifiedAt: Date | null;
  emailVerificationTokenHash: string | null;
  emailVerificationSentTo: string | null;
  emailVerificationExpiresAt: Date | null;
  welcomeCreditsGrantedAt: Date | null;
  googleSub: string | null;
  createdAt: Date;
}

interface CreditRow {
  userId: string;
  delta: number;
  reason: string;
}

type Where = Record<string, unknown>;
type Select = Record<string, boolean> | undefined;

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
}

class FakePrisma {
  readonly users: UserRow[] = [];
  readonly credits: CreditRow[] = [];
  private sequence = 0;

  readonly user = {
    findUnique: (args: { where: Where; select?: Select }) =>
      Promise.resolve(this.pick(this.find(args.where), args.select)),
    findUniqueOrThrow: (args: { where: Where; select?: Select }) => {
      const row = this.find(args.where);
      if (!row) return Promise.reject(new Error('introuvable'));
      return Promise.resolve(this.pick(row, args.select));
    },
    create: (args: { data: Partial<UserRow>; select?: Select }) => {
      const data = args.data;
      if (
        this.users.some(
          (row) =>
            row.email === data.email ||
            (data.googleSub != null && row.googleSub === data.googleSub),
        )
      ) {
        return Promise.reject(uniqueViolation());
      }
      const row = this.insert(data);
      return Promise.resolve(this.pick(row, args.select));
    },
    update: (args: {
      where: Where;
      data: Partial<UserRow>;
      select?: Select;
    }) => {
      const row = this.find(args.where);
      if (!row) return Promise.reject(new Error('introuvable'));
      Object.assign(row, args.data);
      return Promise.resolve(this.pick(row, args.select));
    },
    updateMany: (args: { where: Where; data: Partial<UserRow> }) => {
      const rows = this.users.filter((row) => this.matches(row, args.where));
      for (const row of rows) Object.assign(row, args.data);
      return Promise.resolve({ count: rows.length });
    },
  };

  readonly creditEntry = {
    create: (args: { data: CreditRow }) => {
      this.credits.push(args.data);
      return Promise.resolve(args.data);
    },
  };

  $transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    return callback(this);
  }

  insert(data: Partial<UserRow>): UserRow {
    this.sequence += 1;
    const row: UserRow = {
      id: `user_${this.sequence}`,
      email: '',
      passwordHash: null,
      name: '',
      company: null,
      declaredUsage: null,
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      dailySendLimit: 200,
      emailVerifiedAt: null,
      emailVerificationTokenHash: null,
      emailVerificationSentTo: null,
      emailVerificationExpiresAt: null,
      welcomeCreditsGrantedAt: null,
      googleSub: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      ...data,
    };
    this.users.push(row);
    return row;
  }

  byEmail(email: string): UserRow {
    const row = this.users.find((candidate) => candidate.email === email);
    if (!row) throw new Error(`aucun compte ${email}`);
    return row;
  }

  private find(where: Where): UserRow | null {
    return this.users.find((row) => this.matches(row, where)) ?? null;
  }

  private matches(row: UserRow, where: Where): boolean {
    return Object.entries(where).every(
      ([key, value]) =>
        (row as unknown as Record<string, unknown>)[key] === value,
    );
  }

  private pick(row: UserRow | null, select: Select): unknown {
    if (!row) return null;
    if (!select) return { ...row };
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(select)) {
      if (select[key]) {
        result[key] = (row as unknown as Record<string, unknown>)[key];
      }
    }
    return result;
  }
}

// ─── Jetons Google simulés ───

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function idToken(claims: Record<string, unknown>): string {
  return `${base64url({ alg: 'RS256', kid: 'test' })}.${base64url(claims)}.signature-non-verifiee`;
}

function tokenResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function validClaims(
  nonce: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    nonce,
    sub: 'google-sub-aissatou',
    email: 'aissatou@gmail.com',
    email_verified: true,
    name: 'Aïssatou Diallo',
    ...overrides,
  };
}

// ─── Cookies ───

function setCookies(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown;
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

function cookieNamed(
  response: request.Response,
  name: string,
): string | undefined {
  return setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
}

function cookieValue(cookie: string | undefined): string {
  return cookie?.split(';')[0].split('=').slice(1).join('=') ?? '';
}

function location(response: request.Response): string {
  return String(response.headers.location);
}

function bodyOf(response: request.Response): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

// ─── Application ───

interface Harness {
  app: NestExpressApplication;
  redis: FakeRedis;
  prisma: FakePrisma;
  fetchMock: jest.Mock;
}

async function buildHarness(googleEnabled = true): Promise<Harness> {
  const redis = new FakeRedis();
  const prisma = new FakePrisma();
  const fetchMock = jest.fn();
  global.fetch = fetchMock;

  const env: Record<string, unknown> = {
    NODE_ENV: 'test',
    FRONTEND_ORIGIN: APP_BASE_URL,
    APP_BASE_URL,
    SESSION_COOKIE_DOMAIN: COOKIE_DOMAIN,
    WELCOME_CREDITS,
    TRUST_PROXY_HOPS: 0,
    ...(googleEnabled
      ? {
          GOOGLE_CLIENT_ID: CLIENT_ID,
          GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
          GOOGLE_REDIRECT_URI:
            'https://api.zendou.test/v1/auth/google/callback',
        }
      : {}),
  };
  const configService = { get: (key: string) => env[key] };

  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController, GoogleAuthController],
    providers: [
      AuthService,
      SessionService,
      EmailConfirmationService,
      LoginLockoutService,
      GoogleOAuthService,
      { provide: SESSION_REDIS, useValue: redis },
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: configService },
      {
        provide: EmailsService,
        useValue: {
          sendSystem: jest.fn().mockResolvedValue({ status: 'sent' }),
        },
      },
      { provide: CaptchaService, useValue: { isEnabled: false } },
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
  });
  setupApp(app, configService as unknown as ConfigService);
  await app.init();

  return { app, redis, prisma, fetchMock };
}

/** Départ vers Google : rend le `state`, le `nonce` et le cookie posé. */
async function startFlow(
  harness: Harness,
  next?: string,
): Promise<{ state: string; nonce: string; cookie: string }> {
  const response = await request(harness.app.getHttpServer())
    .get('/v1/auth/google')
    .query(next === undefined ? {} : { next });

  expect(response.status).toBe(302);
  const url = new URL(location(response));
  const state = url.searchParams.get('state') ?? '';
  const nonce = url.searchParams.get('nonce') ?? '';
  const cookie = cookieNamed(response, GOOGLE_STATE_COOKIE_NAME);

  expect(cookieValue(cookie)).toBe(state);

  return { state, nonce, cookie: `${GOOGLE_STATE_COOKIE_NAME}=${state}` };
}

function callback(
  harness: Harness,
  query: Record<string, string>,
  cookie?: string,
) {
  const call = request(harness.app.getHttpServer())
    .get('/v1/auth/google/callback')
    .query(query);
  return cookie ? call.set('Cookie', cookie) : call;
}

/** Parcours complet avec un `id_token` dont on choisit les claims. */
async function completeFlow(
  harness: Harness,
  claims: (nonce: string) => Record<string, unknown>,
  next?: string,
) {
  const { state, nonce, cookie } = await startFlow(harness, next);
  harness.fetchMock.mockResolvedValueOnce(
    tokenResponse({ id_token: idToken(claims(nonce)) }),
  );
  return callback(harness, { code: AUTH_CODE, state }, cookie);
}

function me(harness: Harness, sessionCookie: string | undefined) {
  return request(harness.app.getHttpServer())
    .get('/v1/auth/me')
    .set('Cookie', `${SESSION_COOKIE_NAME}=${cookieValue(sessionCookie)}`);
}

const errorRedirect = (code: string) =>
  `${APP_BASE_URL}/connexion?erreur=${code}`;

describe('Continuer avec Google (B30, intégration HTTP)', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.app.close();
    jest.restoreAllMocks();
  });

  describe('fonction désactivée (variables GOOGLE_* absentes)', () => {
    beforeEach(async () => {
      harness = await buildHarness(false);
    });

    it('GET /v1/auth/providers répond google: false, sans session', async () => {
      const response = await request(harness.app.getHttpServer()).get(
        '/v1/auth/providers',
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ google: false });
    });

    it('GET /v1/auth/google répond 404 au format d’erreur standard', async () => {
      const response = await request(harness.app.getHttpServer()).get(
        '/v1/auth/google',
      );

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        statusCode: 404,
        message: GOOGLE_DISABLED_MESSAGE,
        errors: [GOOGLE_DISABLED_MESSAGE],
      });
      expect(cookieNamed(response, GOOGLE_STATE_COOKIE_NAME)).toBeUndefined();
    });

    it('le rappel redirige vers google_indisponible', async () => {
      const response = await callback(harness, {
        code: AUTH_CODE,
        state: 'x',
      });

      expect(response.status).toBe(302);
      expect(location(response)).toBe(errorRedirect('google_indisponible'));
      expect(harness.fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('fonction activée', () => {
    beforeEach(async () => {
      harness = await buildHarness(true);
    });

    it('GET /v1/auth/providers répond google: true', async () => {
      const response = await request(harness.app.getHttpServer()).get(
        '/v1/auth/providers',
      );

      expect(response.body).toEqual({ google: true });
    });

    it('le départ redirige vers Google avec PKCE S256, state, nonce, et pose le cookie court', async () => {
      const response = await request(harness.app.getHttpServer())
        .get('/v1/auth/google')
        .query({ next: '/dashboard/cles' });

      expect(response.status).toBe(302);
      const url = new URL(location(response));
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('openid email profile');
      expect(url.searchParams.get('prompt')).toBe('select_account');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
      expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Le secret ne part jamais vers le navigateur.
      expect(location(response)).not.toContain(CLIENT_SECRET);

      const cookie = cookieNamed(response, GOOGLE_STATE_COOKIE_NAME) ?? '';
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/v1/auth/google');
      expect(cookie).toContain('Max-Age=600');
      expect(cookie).not.toContain('Domain=');

      // État stocké sous une clé dérivée, jamais le `state` en clair, 600 s.
      const keys = [...harness.redis.store.keys()].filter((key) =>
        key.startsWith('oauth:google:'),
      );
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toContain(url.searchParams.get('state'));
      expect(harness.redis.ttls.get(keys[0])).toBe(600);
    });

    it('succès, création : compte confirmé sans mot de passe, bonus unique, session comme au login, 302 vers next', async () => {
      const response = await completeFlow(
        harness,
        (nonce) => validClaims(nonce),
        '/dashboard/cles',
      );

      expect(response.status).toBe(302);
      expect(location(response)).toBe(`${APP_BASE_URL}/dashboard/cles`);

      // Échange de jeton : code, secret, code_verifier PKCE, délai borné.
      expect(harness.fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = harness.fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const form = new URLSearchParams(init.body as string);
      expect(form.get('code')).toBe(AUTH_CODE);
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(init.signal).toBeInstanceOf(AbortSignal);

      const user = harness.prisma.byEmail('aissatou@gmail.com');
      expect(user.googleSub).toBe('google-sub-aissatou');
      expect(user.passwordHash).toBeNull();
      expect(user.emailVerifiedAt).toBeInstanceOf(Date);
      expect(user.name).toBe('Aïssatou Diallo');
      expect(harness.prisma.credits).toEqual([
        {
          userId: user.id,
          delta: WELCOME_CREDITS,
          reason: CREDIT_REASON_WELCOME_BONUS,
          reference: null,
        },
      ]);

      // Cookie de session : mêmes attributs que le login.
      const session = cookieNamed(response, SESSION_COOKIE_NAME) ?? '';
      expect(session).toContain(`Domain=${COOKIE_DOMAIN}`);
      expect(session).toContain('HttpOnly');
      expect(session).toContain('SameSite=Lax');
      expect(session).toContain('Path=/');
      expect(session).toContain('Max-Age=604800');

      // Cookie d'état effacé.
      expect(cookieNamed(response, GOOGLE_STATE_COOKIE_NAME)).toMatch(
        /Expires=Thu, 01 Jan 1970/,
      );

      const profile = await me(harness, session);
      expect(profile.status).toBe(200);
      expect(profile.body).toMatchObject({
        email: 'aissatou@gmail.com',
        hasPassword: false,
        googleLinked: true,
      });
      expect(profile.body).not.toHaveProperty('passwordHash');
      expect(profile.body).not.toHaveProperty('googleSub');
    });

    it('nom absent : repli sur la partie locale de l’adresse', async () => {
      await completeFlow(harness, (nonce) =>
        validClaims(nonce, { name: undefined }),
      );

      expect(harness.prisma.byEmail('aissatou@gmail.com').name).toBe(
        'aissatou',
      );
    });

    it('succès par googleSub : connexion sans création ni nouveau bonus', async () => {
      await completeFlow(harness, (nonce) => validClaims(nonce));
      // Google peut changer l'adresse d'un compte : le `sub` fait foi.
      const response = await completeFlow(harness, (nonce) =>
        validClaims(nonce, { email: 'nouvelle-adresse@gmail.com' }),
      );

      expect(location(response)).toBe(`${APP_BASE_URL}/dashboard`);
      expect(harness.prisma.users).toHaveLength(1);
      expect(harness.prisma.credits).toHaveLength(1);
      expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeDefined();
    });

    it('rattachement d’un compte CONFIRMÉ : mot de passe et sessions conservés, pas de nouveau bonus', async () => {
      const passwordHash = await argon2.hash('motdepasse-solide', {
        type: argon2.argon2id,
      });
      const existing = harness.prisma.insert({
        email: 'aissatou@gmail.com',
        passwordHash,
        name: 'Aïssatou',
        emailVerifiedAt: new Date('2026-08-01T00:00:00.000Z'),
        welcomeCreditsGrantedAt: new Date('2026-08-01T00:00:00.000Z'),
      });
      const sessions = new SessionService(
        harness.redis as unknown as ConstructorParameters<
          typeof SessionService
        >[0],
      );
      const oldToken = await sessions.create(existing.id);

      const response = await completeFlow(harness, (nonce) =>
        validClaims(nonce, { email: 'Aissatou@Gmail.com' }),
      );

      expect(location(response)).toBe(`${APP_BASE_URL}/dashboard`);
      expect(existing.googleSub).toBe('google-sub-aissatou');
      expect(existing.passwordHash).toBe(passwordHash);
      expect(harness.prisma.credits).toHaveLength(0);
      expect(harness.prisma.users).toHaveLength(1);
      expect((await me(harness, `x=${oldToken}`)).status).toBe(200);

      const profile = await me(
        harness,
        cookieNamed(response, SESSION_COOKIE_NAME),
      );
      expect(profile.body).toMatchObject({
        hasPassword: true,
        googleLinked: true,
      });
    });

    it('rattachement d’un compte NON confirmé : mot de passe effacé, sessions révoquées, confirmé, bonus unique', async () => {
      const passwordHash = await argon2.hash('mot-de-passe-du-squatteur', {
        type: argon2.argon2id,
      });
      const existing = harness.prisma.insert({
        email: 'aissatou@gmail.com',
        passwordHash,
        name: 'Squatteur',
      });
      const sessions = new SessionService(
        harness.redis as unknown as ConstructorParameters<
          typeof SessionService
        >[0],
      );
      const squatterToken = await sessions.create(existing.id);
      expect((await me(harness, `x=${squatterToken}`)).status).toBe(200);

      const response = await completeFlow(harness, (nonce) =>
        validClaims(nonce),
      );

      expect(location(response)).toBe(`${APP_BASE_URL}/dashboard`);
      expect(existing.googleSub).toBe('google-sub-aissatou');
      expect(existing.passwordHash).toBeNull();
      expect(existing.emailVerifiedAt).toBeInstanceOf(Date);
      expect(harness.prisma.credits).toEqual([
        {
          userId: existing.id,
          delta: WELCOME_CREDITS,
          reason: CREDIT_REASON_WELCOME_BONUS,
          reference: null,
        },
      ]);
      // La session ouverte avec le mot de passe non prouvé ne vaut plus rien.
      expect((await me(harness, `x=${squatterToken}`)).status).toBe(401);

      // La nouvelle session, elle, fonctionne.
      const profile = await me(
        harness,
        cookieNamed(response, SESSION_COOKIE_NAME),
      );
      expect(profile.status).toBe(200);
      expect(profile.body).toMatchObject({
        hasPassword: false,
        googleLinked: true,
      });

      // Le mot de passe du squatteur ne connecte plus.
      const login = await request(harness.app.getHttpServer())
        .post('/v1/auth/login')
        .send({
          email: 'aissatou@gmail.com',
          password: 'mot-de-passe-du-squatteur',
        });
      expect(login.status).toBe(401);
      expect(bodyOf(login).code).toBe(PASSWORD_NOT_SET_CODE);

      // Nouvelle connexion : toujours un seul bonus.
      await completeFlow(harness, (nonce) => validClaims(nonce));
      expect(harness.prisma.credits).toHaveLength(1);
    });

    it('google_compte_conflit : adresse déjà rattachée à un AUTRE identifiant Google, rien ne change', async () => {
      const existing = harness.prisma.insert({
        email: 'aissatou@gmail.com',
        passwordHash: 'hash',
        name: 'Aïssatou',
        googleSub: 'un-autre-sub',
        emailVerifiedAt: new Date(),
      });

      const response = await completeFlow(harness, (nonce) =>
        validClaims(nonce),
      );

      expect(location(response)).toBe(errorRedirect('google_compte_conflit'));
      expect(existing.googleSub).toBe('un-autre-sub');
      expect(existing.passwordHash).toBe('hash');
      expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined();
    });

    it('compte suspendu : session créée comme au login, puis 403 des gardes', async () => {
      harness.prisma.insert({
        email: 'aissatou@gmail.com',
        googleSub: 'google-sub-aissatou',
        name: 'Aïssatou',
        status: UserStatus.SUSPENDED,
        emailVerifiedAt: new Date(),
      });

      const response = await completeFlow(harness, (nonce) =>
        validClaims(nonce),
      );

      expect(location(response)).toBe(`${APP_BASE_URL}/dashboard`);
      const profile = await me(
        harness,
        cookieNamed(response, SESSION_COOKIE_NAME),
      );
      expect(profile.status).toBe(403);
    });

    it.each([
      [
        'email_verified faux',
        { email_verified: false },
        'google_email_non_verifie',
      ],
      [
        'email_verified chaîne "true"',
        { email_verified: 'true' },
        'google_email_non_verifie',
      ],
      [
        'email_verified absent',
        { email_verified: undefined },
        'google_email_non_verifie',
      ],
      [
        'aud d’un autre client',
        { aud: 'autre-client.apps.googleusercontent.com' },
        'google_indisponible',
      ],
      [
        'iss inconnu',
        { iss: 'https://evil.example.com' },
        'google_indisponible',
      ],
      [
        'exp dépassé (au-delà de la tolérance)',
        { exp: Math.floor(Date.now() / 1000) - 120 },
        'google_indisponible',
      ],
      [
        'nonce différent',
        { nonce: 'nonce-d-un-autre-parcours' },
        'google_session_expiree',
      ],
      ['sub absent', { sub: undefined }, 'google_indisponible'],
      ['email absent', { email: undefined }, 'google_indisponible'],
    ])(
      'id_token refusé (%s) : %s, aucun compte, aucune session',
      async (_label, overrides, code) => {
        const response = await completeFlow(harness, (nonce) =>
          validClaims(nonce, overrides),
        );

        expect(response.status).toBe(302);
        expect(location(response)).toBe(errorRedirect(code));
        expect(harness.prisma.users).toHaveLength(0);
        expect(cookieNamed(response, SESSION_COOKIE_NAME)).toBeUndefined();
      },
    );

    it('iss sans schéma (accounts.google.com) accepté', async () => {
      const response = await completeFlow(harness, (nonce) =>
        validClaims(nonce, { iss: 'accounts.google.com' }),
      );

      expect(location(response)).toBe(`${APP_BASE_URL}/dashboard`);
    });

    it('state absent : google_session_expiree, aucun échange', async () => {
      const { cookie } = await startFlow(harness);

      const response = await callback(harness, { code: AUTH_CODE }, cookie);

      expect(location(response)).toBe(errorRedirect('google_session_expiree'));
      expect(harness.fetchMock).not.toHaveBeenCalled();
      expect(cookieNamed(response, GOOGLE_STATE_COOKIE_NAME)).toMatch(
        /Expires=Thu, 01 Jan 1970/,
      );
    });

    it('state différent du cookie : google_session_expiree, et l’état légitime n’est pas brûlé', async () => {
      const victim = await startFlow(harness);
      const attacker = await startFlow(harness);

      // Le navigateur de la victime reçoit le `state` de l'attaquant.
      const response = await callback(
        harness,
        { code: AUTH_CODE, state: attacker.state },
        victim.cookie,
      );

      expect(location(response)).toBe(errorRedirect('google_session_expiree'));
      expect(harness.fetchMock).not.toHaveBeenCalled();

      // Le parcours légitime de la victime aboutit toujours.
      harness.fetchMock.mockResolvedValueOnce(
        tokenResponse({ id_token: idToken(validClaims(victim.nonce)) }),
      );
      const legit = await callback(
        harness,
        { code: AUTH_CODE, state: victim.state },
        victim.cookie,
      );
      expect(location(legit)).toBe(`${APP_BASE_URL}/dashboard`);
    });

    it('cookie d’état absent : google_session_expiree', async () => {
      const { state } = await startFlow(harness);

      const response = await callback(harness, { code: AUTH_CODE, state });

      expect(location(response)).toBe(errorRedirect('google_session_expiree'));
      expect(harness.fetchMock).not.toHaveBeenCalled();
    });

    it('state déjà consommé (rejeu du rappel) : google_session_expiree', async () => {
      const { state, nonce, cookie } = await startFlow(harness);
      harness.fetchMock.mockResolvedValue(
        tokenResponse({ id_token: idToken(validClaims(nonce)) }),
      );

      const first = await callback(harness, { code: AUTH_CODE, state }, cookie);
      const replay = await callback(
        harness,
        { code: AUTH_CODE, state },
        cookie,
      );

      expect(location(first)).toBe(`${APP_BASE_URL}/dashboard`);
      expect(location(replay)).toBe(errorRedirect('google_session_expiree'));
      expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('access_denied (refus sur l’écran Google) : google_annule, état consommé', async () => {
      const { state, cookie } = await startFlow(harness);

      const response = await callback(
        harness,
        { error: 'access_denied', state },
        cookie,
      );

      expect(location(response)).toBe(errorRedirect('google_annule'));
      expect(harness.fetchMock).not.toHaveBeenCalled();
      expect(
        [...harness.redis.store.keys()].some((key) =>
          key.startsWith('oauth:google:'),
        ),
      ).toBe(false);
    });

    it.each([
      [
        'réponse 400 de Google',
        () =>
          Promise.resolve(
            tokenResponse({ error: 'invalid_grant' }, false, 400),
          ),
      ],
      [
        'délai dépassé',
        () =>
          Promise.reject(
            Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
          ),
      ],
      [
        'réponse illisible',
        () =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.reject(new SyntaxError('JSON invalide')),
          } as unknown as Response),
      ],
      [
        'id_token absent',
        () => Promise.resolve(tokenResponse({ access_token: 'a' })),
      ],
      [
        'id_token mal formé',
        () => Promise.resolve(tokenResponse({ id_token: 'pas-un-jwt' })),
      ],
    ])(
      'échange en échec (%s) : google_indisponible, journalisé sans secret ni code',
      async (_label, respond) => {
        const warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
        const { state, cookie } = await startFlow(harness);
        harness.fetchMock.mockImplementationOnce(respond);

        const response = await callback(
          harness,
          { code: AUTH_CODE, state },
          cookie,
        );

        expect(location(response)).toBe(errorRedirect('google_indisponible'));
        expect(harness.prisma.users).toHaveLength(0);

        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).toContain('google_indisponible');
        expect(logged).not.toContain(AUTH_CODE);
        expect(logged).not.toContain(CLIENT_SECRET);
      },
    );

    it.each([
      ['//evil.com'],
      ['https://evil.com'],
      ['/\\evil.com'],
      ['evil.com'],
    ])('next hostile (%s) ramené à /dashboard', async (next) => {
      const response = await completeFlow(
        harness,
        (nonce) => validClaims(nonce),
        next,
      );

      expect(location(response)).toBe(`${APP_BASE_URL}/dashboard`);
    });
  });

  describe('comptes sans mot de passe (PASSWORD_NOT_SET) et forme d’AuthUser', () => {
    beforeEach(async () => {
      harness = await buildHarness(true);
    });

    async function googleOnlySession(): Promise<string | undefined> {
      const response = await completeFlow(harness, (nonce) =>
        validClaims(nonce),
      );
      return cookieNamed(response, SESSION_COOKIE_NAME);
    }

    it('login : 401 avec code PASSWORD_NOT_SET, sans argon2 ni échec compté', async () => {
      await googleOnlySession();
      const verify = argon2.verify as unknown as jest.Mock;
      verify.mockClear();

      const response = await request(harness.app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: 'aissatou@gmail.com', password: 'nimporte-quoi' });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        statusCode: 401,
        code: PASSWORD_NOT_SET_CODE,
        message: PASSWORD_NOT_SET_LOGIN_MESSAGE,
        errors: [PASSWORD_NOT_SET_LOGIN_MESSAGE],
      });
      expect(verify).not.toHaveBeenCalled();
      expect(
        [...harness.redis.store.keys()].some((key) =>
          key.startsWith('lockout:'),
        ),
      ).toBe(false);
    });

    it('change-password : 400 avec code PASSWORD_NOT_SET, rien d’écrit', async () => {
      const session = await googleOnlySession();

      const response = await request(harness.app.getHttpServer())
        .post('/v1/auth/change-password')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${cookieValue(session)}`)
        .send({
          currentPassword: 'nimporte-quoi',
          newPassword: 'nouveau-mot-de-passe',
        });

      expect(response.status).toBe(400);
      expect(bodyOf(response).code).toBe(PASSWORD_NOT_SET_CODE);
      expect(typeof bodyOf(response).message).toBe('string');
      expect(
        harness.prisma.byEmail('aissatou@gmail.com').passwordHash,
      ).toBeNull();
    });

    it('PATCH /v1/auth/me rend hasPassword / googleLinked, sans passwordHash ni googleSub', async () => {
      const session = await googleOnlySession();

      const response = await request(harness.app.getHttpServer())
        .patch('/v1/auth/me')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${cookieValue(session)}`)
        .send({ name: 'Aïssatou D.' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        name: 'Aïssatou D.',
        hasPassword: false,
        googleLinked: true,
      });
      expect(response.body).not.toHaveProperty('passwordHash');
      expect(response.body).not.toHaveProperty('googleSub');
    });

    it('compte à mot de passe : GET et PATCH /me rendent hasPassword true, googleLinked false', async () => {
      const register = await request(harness.app.getHttpServer())
        .post('/v1/auth/register')
        .send({
          email: 'mamadou@example.com',
          password: 'motdepasse-solide',
          name: 'Mamadou',
        });
      expect(register.status).toBe(201);
      expect(register.body).toMatchObject({
        hasPassword: true,
        googleLinked: false,
      });
      const session = cookieNamed(register, SESSION_COOKIE_NAME);

      const profile = await me(harness, session);
      expect(profile.body).toMatchObject({
        hasPassword: true,
        googleLinked: false,
      });

      const patched = await request(harness.app.getHttpServer())
        .patch('/v1/auth/me')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${cookieValue(session)}`)
        .send({ company: 'Kingreys' });
      expect(patched.body).toMatchObject({
        hasPassword: true,
        googleLinked: false,
      });
      expect(patched.body).not.toHaveProperty('passwordHash');
    });
  });
});

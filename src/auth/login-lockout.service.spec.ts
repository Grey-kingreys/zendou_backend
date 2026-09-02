import { createHash } from 'node:crypto';
import { HttpException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { UserRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { TOO_MANY_REQUESTS_MESSAGE } from '../rate-limit/rate-limit.constants';
import { AuthService } from './auth.service';
import {
  INVALID_CREDENTIALS_MESSAGE,
  LOGIN_LOCKOUT_BLOCK_PREFIX,
  LOGIN_LOCKOUT_DEFAULTS,
  LOGIN_LOCKOUT_FAIL_PREFIX,
  LOGIN_LOCKOUT_LEVEL_PREFIX,
} from './auth.constants';
import { EmailConfirmationService } from './email-confirmation.service';
import {
  LoginLockoutService,
  type LoginLockedBody,
} from './login-lockout.service';
import { SessionService } from './session.service';

/**
 * argon2 est un module natif : ses exports ne sont pas redéfinissables, donc
 * `jest.spyOn` échoue dessus. On le remplace entièrement, ce qui rend le
 * comptage des vérifications possible - et accessoirement ces tests
 * instantanés, là où une dizaine de hachages argon2id réels prendraient une
 * seconde.
 */
jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(),
  verify: jest.fn(),
}));

const verify = argon2.verify as jest.MockedFunction<typeof argon2.verify>;

const EMAIL = 'cible@example.com';
const HASH = createHash('sha256').update(EMAIL).digest('hex');

/**
 * Redis en mémoire, avec **horloge simulée**.
 *
 * Les durées de vie sont ici de vraies durées de vie : c'est ce qui permet de
 * prouver qu'un blocage expire, puis que le suivant dure deux fois plus
 * longtemps. Même esprit que `smtp/fixtures/fake-throttle-redis.ts` (compter
 * réellement plutôt que rendre des réponses pré-programmées), avec en plus la
 * dimension temporelle dont le verrouillage progressif dépend entièrement.
 */
class FakeLockoutRedis {
  /** Quand vrai, toute commande échoue - pour éprouver le repli. */
  failing = false;

  private now = 0;
  private readonly store = new Map<
    string,
    { value: string; expiresAt?: number }
  >();

  /** Avance l'horloge de `seconds` secondes. */
  advance(seconds: number): void {
    this.now += seconds;
  }

  /** Clés encore vivantes, dans l'ordre d'insertion. */
  keys(): string[] {
    return [...this.store.keys()].filter((key) => this.read(key) !== undefined);
  }

  ttl(key: string): Promise<number> {
    return this.run(() => {
      const entry = this.read(key);

      if (!entry) {
        return -2;
      }

      return entry.expiresAt === undefined
        ? -1
        : Math.max(0, Math.ceil(entry.expiresAt - this.now));
    });
  }

  incr(key: string): Promise<number> {
    return this.run(() => {
      const entry = this.read(key);
      const next = Number(entry?.value ?? '0') + 1;

      this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt });

      return next;
    });
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.run(() => {
      const entry = this.read(key);

      if (!entry) {
        return 0;
      }

      this.store.set(key, { ...entry, expiresAt: this.now + seconds });

      return 1;
    });
  }

  set(
    key: string,
    value: string,
    _mode: string,
    seconds: number,
  ): Promise<'OK'> {
    return this.run(() => {
      this.store.set(key, { value, expiresAt: this.now + seconds });

      return 'OK' as const;
    });
  }

  del(...keys: string[]): Promise<number> {
    return this.run(() => {
      let removed = 0;

      for (const key of keys) {
        if (this.store.delete(key)) {
          removed += 1;
        }
      }

      return removed;
    });
  }

  asRedis(): Redis {
    return this as unknown as Redis;
  }

  private read(key: string): { value: string; expiresAt?: number } | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now) {
      this.store.delete(key);
      return undefined;
    }

    return entry;
  }

  private run<T>(action: () => T): Promise<T> {
    return this.failing
      ? Promise.reject(new Error('Redis injoignable'))
      : Promise.resolve(action());
  }
}

const configStub = { get: () => undefined } as unknown as ConfigService;

function buildService(redis: FakeLockoutRedis): LoginLockoutService {
  return new LoginLockoutService(redis.asRedis(), configStub);
}

/** Joue `count` échecs consécutifs sur la même adresse. */
async function fail(
  service: LoginLockoutService,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await service.recordFailure(EMAIL);
  }
}

/** Le corps du 429, ou `undefined` si l'appel est passé. */
async function lockedBody(
  service: LoginLockoutService,
): Promise<LoginLockedBody | undefined> {
  try {
    await service.assertNotLocked(EMAIL);
    return undefined;
  } catch (error) {
    return (error as HttpException).getResponse() as LoginLockedBody;
  }
}

describe('LoginLockoutService', () => {
  let redis: FakeLockoutRedis;
  let service: LoginLockoutService;
  let warned: jest.SpyInstance;

  beforeEach(() => {
    redis = new FakeLockoutRedis();
    service = buildService(redis);
    warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warned.mockRestore();
  });

  it("laisse passer tant que le seuil n'est pas atteint", async () => {
    await fail(service, LOGIN_LOCKOUT_DEFAULTS.THRESHOLD - 1);

    await expect(service.assertNotLocked(EMAIL)).resolves.toBeUndefined();
  });

  it('verrouille au seuil, avec le délai restant dans le corps', async () => {
    await fail(service, LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);

    const body = await lockedBody(service);

    expect(body).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: TOO_MANY_REQUESTS_MESSAGE,
      retryAfter: LOGIN_LOCKOUT_DEFAULTS.BASE_SECONDS,
    });
  });

  it('remet le compteur à zéro en posant le blocage', async () => {
    await fail(service, LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);

    // Le compteur d'échecs a disparu : le palier suivant repart de zéro et
    // redemandera `THRESHOLD` échecs.
    expect(redis.keys()).not.toContain(`${LOGIN_LOCKOUT_FAIL_PREFIX}${HASH}`);
    expect(redis.keys()).toContain(`${LOGIN_LOCKOUT_BLOCK_PREFIX}${HASH}`);
  });

  it('double la durée du blocage à chaque palier', async () => {
    const base = LOGIN_LOCKOUT_DEFAULTS.BASE_SECONDS;

    await fail(service, LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);
    expect((await lockedBody(service))?.retryAfter).toBe(base);

    // Le blocage expire, l'attaquant reprend : cinq nouveaux échecs, et il
    // attend cette fois deux fois plus longtemps.
    redis.advance(base);
    await expect(service.assertNotLocked(EMAIL)).resolves.toBeUndefined();

    await fail(service, LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);
    expect((await lockedBody(service))?.retryAfter).toBe(base * 2);

    redis.advance(base * 2);
    await fail(service, LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);
    expect((await lockedBody(service))?.retryAfter).toBe(base * 4);
  });

  it('plafonne le doublement', async () => {
    // Sans plafond, le dixième palier dépasserait la journée : le
    // verrouillage cesserait de protéger le compte pour se mettre à le punir.
    for (let palier = 0; palier < 10; palier++) {
      await fail(service, LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);
      const body = await lockedBody(service);

      expect(body?.retryAfter).toBeLessThanOrEqual(
        LOGIN_LOCKOUT_DEFAULTS.MAX_SECONDS,
      );

      redis.advance(body!.retryAfter);
    }

    await fail(service, LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);

    expect((await lockedBody(service))?.retryAfter).toBe(
      LOGIN_LOCKOUT_DEFAULTS.MAX_SECONDS,
    );
  });

  it('efface compteur et palier après une connexion réussie', async () => {
    await fail(service, LOGIN_LOCKOUT_DEFAULTS.THRESHOLD - 1);
    await service.recordSuccess(EMAIL);

    expect(redis.keys()).toEqual([]);

    // Preuve que la remise à zéro est réelle : il faut de nouveau le seuil
    // complet pour reverrouiller, et le palier repart de la durée de base.
    await fail(service, LOGIN_LOCKOUT_DEFAULTS.THRESHOLD - 1);
    await expect(service.assertNotLocked(EMAIL)).resolves.toBeUndefined();

    await service.recordFailure(EMAIL);
    expect((await lockedBody(service))?.retryAfter).toBe(
      LOGIN_LOCKOUT_DEFAULTS.BASE_SECONDS,
    );
  });

  it("n'écrit jamais l'adresse en clair dans Redis", async () => {
    await fail(service, LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);

    for (const key of redis.keys()) {
      expect(key).not.toContain(EMAIL);
      expect(key).toContain(HASH);
    }

    expect(redis.keys()).toContain(`${LOGIN_LOCKOUT_LEVEL_PREFIX}${HASH}`);
  });

  it('laisse passer quand Redis est injoignable', async () => {
    redis.failing = true;

    await expect(service.recordFailure(EMAIL)).resolves.toBeUndefined();
    await expect(service.assertNotLocked(EMAIL)).resolves.toBeUndefined();
    await expect(service.recordSuccess(EMAIL)).resolves.toBeUndefined();

    // Panne signalée, mais jamais propagée à l'appelant.
    expect(warned).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Le verrouillage vu depuis `AuthService.login` : c'est là qu'il doit
// réellement épargner à la base et à argon2 le coût d'un bourrinage.
// ---------------------------------------------------------------------------

describe('AuthService.login - verrouillage progressif', () => {
  const findUnique = jest.fn();
  const sessionService = {
    create: jest.fn().mockResolvedValue('session-token'),
  } as unknown as SessionService;
  const emailConfirmation = {
    issueAndSend: jest.fn(),
  } as unknown as EmailConfirmationService;

  let redis: FakeLockoutRedis;
  let service: AuthService;
  let warned: jest.SpyInstance;

  const compte = {
    id: 'user_1',
    email: EMAIL,
    name: 'Aïssatou Diallo',
    company: null,
    declaredUsage: null,
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    emailVerifiedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    passwordHash: '$argon2id$empreinte-factice',
  };

  const login = () =>
    service.login({ email: EMAIL, password: 'mauvais-mot-de-passe' });

  beforeEach(() => {
    jest.clearAllMocks();
    redis = new FakeLockoutRedis();
    verify.mockResolvedValue(false);
    warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    findUnique.mockResolvedValue(compte);

    service = new AuthService(
      { user: { findUnique } } as unknown as PrismaService,
      sessionService,
      emailConfirmation,
      configStub,
      buildService(redis),
    );
  });

  afterEach(() => {
    warned.mockRestore();
  });

  it('refuse la 6ᵉ tentative sans toucher ni à Prisma ni à argon2', async () => {
    for (
      let attempt = 1;
      attempt <= LOGIN_LOCKOUT_DEFAULTS.THRESHOLD;
      attempt++
    ) {
      await expect(login()).rejects.toMatchObject({
        message: INVALID_CREDENTIALS_MESSAGE,
      });
    }

    expect(findUnique).toHaveBeenCalledTimes(LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);
    expect(verify).toHaveBeenCalledTimes(LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);

    let captured: unknown;

    try {
      await login();
    } catch (error) {
      captured = error;
    }

    const exception = captured as HttpException;

    expect(exception.getStatus()).toBe(429);
    expect(exception.getResponse()).toMatchObject({
      message: TOO_MANY_REQUESTS_MESSAGE,
      retryAfter: LOGIN_LOCKOUT_DEFAULTS.BASE_SECONDS,
    });

    // Le point du verrouillage : la tentative refusée n'a coûté ni une lecture
    // en base, ni un hachage argon2id.
    expect(findUnique).toHaveBeenCalledTimes(LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);
    expect(verify).toHaveBeenCalledTimes(LOGIN_LOCKOUT_DEFAULTS.THRESHOLD);
  });

  it('verrouille aussi une adresse qui ne correspond à aucun compte', async () => {
    // Pas d'oracle : email inconnu et mot de passe faux se comportent
    // exactement pareil, sans quoi la différence énumérerait les comptes.
    findUnique.mockResolvedValue(null);

    for (
      let attempt = 1;
      attempt <= LOGIN_LOCKOUT_DEFAULTS.THRESHOLD;
      attempt++
    ) {
      await expect(login()).rejects.toMatchObject({
        message: INVALID_CREDENTIALS_MESSAGE,
      });
    }

    await expect(login()).rejects.toMatchObject({
      response: { message: TOO_MANY_REQUESTS_MESSAGE },
    });
  });

  it('repart de zéro dès qu’une connexion réussit', async () => {
    await expect(login()).rejects.toThrow();
    await expect(login()).rejects.toThrow();

    verify.mockResolvedValue(true);
    await expect(login()).resolves.toMatchObject({ token: 'session-token' });

    expect(redis.keys()).toEqual([]);

    // Les deux échecs d'avant ne comptent plus : le seuil complet est de
    // nouveau nécessaire.
    verify.mockResolvedValue(false);
    for (
      let attempt = 1;
      attempt <= LOGIN_LOCKOUT_DEFAULTS.THRESHOLD - 1;
      attempt++
    ) {
      await expect(login()).rejects.toThrow();
    }

    await expect(login()).rejects.toMatchObject({
      message: INVALID_CREDENTIALS_MESSAGE,
    });
  });

  it('reste un 401 normal quand Redis est en panne', async () => {
    redis.failing = true;

    for (
      let attempt = 1;
      attempt <= LOGIN_LOCKOUT_DEFAULTS.THRESHOLD + 3;
      attempt++
    ) {
      await expect(login()).rejects.toMatchObject({
        status: 401,
        message: INVALID_CREDENTIALS_MESSAGE,
      });
    }
  });
});

import { HttpException, Logger, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { ThrottlerRequest, ThrottlerStorage } from '@nestjs/throttler';
import { AuthController } from '../auth/auth.controller';
import { RateLimitPolicyService } from './rate-limit-policy.service';
import {
  MINUTE_WINDOW_MS,
  RATE_LIMIT_HEADERS,
  TOO_MANY_REQUESTS_MESSAGE,
} from './rate-limit.constants';
import { RateLimitGuard } from './rate-limit.guard';

/** Enregistrement rendu par le stockage, dans l'ordre des appels. */
type StorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/** Réponse Express réduite à ce que le garde en utilise. */
class FakeResponse {
  readonly headers = new Map<string, string>();

  getHeader(name: string): string | undefined {
    return this.headers.get(name);
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

/**
 * Handler réel de `POST /v1/auth/login` : c'est lui qui porte la métadonnée
 * `@RateLimit(...)` que le garde relit. Lu par indexation plutôt qu'en accès
 * direct, comme dans `rate-limit-policy.service.spec.ts` - il n'est jamais
 * appelé, seulement identifié.
 */
const loginHandler: unknown = (
  AuthController.prototype as unknown as Record<string, unknown>
).login;

function contextFor(response: FakeResponse): ExecutionContext {
  return {
    getType: () => 'http',
    getClass: () => AuthController,
    getHandler: () => loginHandler,
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        originalUrl: '/v1/auth/login',
        ip: '203.0.113.5',
      }),
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

/**
 * `handleRequest` est `protected` : on l'appelle par sa signature publique
 * plutôt que d'exposer la méthode dans le code de production pour les seuls
 * besoins du test.
 */
type Callable = {
  handleRequest: (props: ThrottlerRequest) => Promise<boolean>;
};

function buildGuard(records: StorageRecord[]): {
  guard: RateLimitGuard;
  increments: string[];
} {
  const increments: string[] = [];
  const queue = [...records];

  const storage: ThrottlerStorage = {
    increment: (key: string) => {
      increments.push(key);
      return Promise.resolve(queue.shift()!);
    },
  };

  const policyService = new RateLimitPolicyService({
    get: () => undefined,
  } as unknown as ConfigService);

  const guard = new RateLimitGuard(
    { throttlers: [] },
    storage,
    new Reflector(),
    policyService,
  );

  return { guard, increments };
}

function requestProps(
  context: ExecutionContext,
  name: string,
  limit: number,
): ThrottlerRequest {
  return {
    context,
    limit,
    ttl: MINUTE_WINDOW_MS,
    throttler: { name, ttl: MINUTE_WINDOW_MS, limit },
    blockDuration: MINUTE_WINDOW_MS,
    getTracker: () => Promise.resolve('ip:203.0.113.5'),
    generateKey: (_context, tracker, throttlerName) =>
      `${throttlerName}:${tracker}`,
  };
}

const passing = (totalHits: number, timeToExpire: number): StorageRecord => ({
  totalHits,
  timeToExpire,
  isBlocked: false,
  timeToBlockExpire: 0,
});

describe('RateLimitGuard - en-têtes de débit', () => {
  it('publie limite, reste et remise à zéro sans suffixe de compteur', async () => {
    const response = new FakeResponse();
    const { guard, increments } = buildGuard([passing(2, 47)]);

    await (guard as unknown as Callable).handleRequest(
      requestProps(contextFor(response), 'minute', 5),
    );

    expect(response.getHeader(RATE_LIMIT_HEADERS.LIMIT)).toBe('5');
    expect(response.getHeader(RATE_LIMIT_HEADERS.REMAINING)).toBe('3');
    expect(response.getHeader(RATE_LIMIT_HEADERS.RESET)).toBe('47');

    // Aucun en-tête suffixé : c'est ce que la bibliothèque aurait produit et
    // que `setHeaders: false` nous permet d'éviter.
    expect([...response.headers.keys()]).toEqual([
      RATE_LIMIT_HEADERS.LIMIT,
      RATE_LIMIT_HEADERS.REMAINING,
      RATE_LIMIT_HEADERS.RESET,
    ]);

    // La séquence de la bibliothèque est respectée : le compteur a bien été
    // incrémenté sur la clé produite par `generateKey`.
    expect(increments).toEqual(['minute:ip:203.0.113.5']);
  });

  it('ne laisse jamais un reste négatif', async () => {
    const response = new FakeResponse();
    const { guard } = buildGuard([passing(9, 12)]);

    await (guard as unknown as Callable).handleRequest(
      requestProps(contextFor(response), 'minute', 5),
    );

    expect(response.getHeader(RATE_LIMIT_HEADERS.REMAINING)).toBe('0');
  });

  it('expose le compteur le plus contraignant quand plusieurs s’appliquent', async () => {
    // Cas réel de `/auth/login` : minute et heure, IP et email. Le second
    // compteur laisse moins de marge que le premier : c'est lui qui doit
    // s'afficher, sans quoi le client se croirait plus libre qu'il ne l'est.
    const response = new FakeResponse();
    const context = contextFor(response);
    const { guard } = buildGuard([passing(1, 55), passing(18, 3400)]);
    const callable = guard as unknown as Callable;

    await callable.handleRequest(requestProps(context, 'minute', 5));
    await callable.handleRequest(requestProps(context, 'hour', 20));

    expect(response.getHeader(RATE_LIMIT_HEADERS.LIMIT)).toBe('20');
    expect(response.getHeader(RATE_LIMIT_HEADERS.REMAINING)).toBe('2');
    expect(response.getHeader(RATE_LIMIT_HEADERS.RESET)).toBe('3400');
  });

  it('ne se laisse pas réécrire par un compteur plus généreux', async () => {
    const response = new FakeResponse();
    const context = contextFor(response);
    const { guard } = buildGuard([passing(4, 55), passing(2, 3400)]);
    const callable = guard as unknown as Callable;

    await callable.handleRequest(requestProps(context, 'minute', 5));
    await callable.handleRequest(requestProps(context, 'hour', 20));

    // La minute ne laisse qu'une requête, l'heure dix-huit : les trois
    // en-têtes restent ceux de la minute, et restent cohérents entre eux.
    expect(response.getHeader(RATE_LIMIT_HEADERS.LIMIT)).toBe('5');
    expect(response.getHeader(RATE_LIMIT_HEADERS.REMAINING)).toBe('1');
    expect(response.getHeader(RATE_LIMIT_HEADERS.RESET)).toBe('55');
  });

  it('lève le 429 français avec Retry-After quand le compteur est bloqué', async () => {
    const warned = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      const response = new FakeResponse();
      const { guard } = buildGuard([
        {
          totalHits: 6,
          timeToExpire: 30,
          isBlocked: true,
          timeToBlockExpire: 42,
        },
      ]);

      await expect(
        (guard as unknown as Callable).handleRequest(
          requestProps(contextFor(response), 'minute', 5),
        ),
      ).rejects.toBeInstanceOf(HttpException);

      expect(response.getHeader('Retry-After')).toBe('42');
      // Un compteur bloqué ne publie pas de budget : la réponse est un refus,
      // pas une autorisation partielle.
      expect(response.getHeader(RATE_LIMIT_HEADERS.REMAINING)).toBeUndefined();
      expect(warned).toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  it('rend le corps 429 attendu, sans dire quel compteur a sauté', async () => {
    const warned = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      const { guard } = buildGuard([
        {
          totalHits: 6,
          timeToExpire: 30,
          isBlocked: true,
          timeToBlockExpire: 42,
        },
      ]);

      let captured: unknown;

      try {
        await (guard as unknown as Callable).handleRequest(
          requestProps(contextFor(new FakeResponse()), 'minute', 5),
        );
      } catch (error) {
        captured = error;
      }

      expect((captured as HttpException).getStatus()).toBe(429);
      expect((captured as HttpException).getResponse()).toEqual({
        statusCode: 429,
        error: 'Too Many Requests',
        message: TOO_MANY_REQUESTS_MESSAGE,
        retryAfter: 42,
      });
    } finally {
      warned.mockRestore();
    }
  });
});

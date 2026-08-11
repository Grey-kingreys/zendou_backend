import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import { RATE_LIMIT_POLICY } from './rate-limit.constants';
import type { RateLimitPolicyId } from './rate-limit.types';

/** Clé de métadonnée portant l'identifiant de politique d'une route. */
export const RATE_LIMIT_POLICY_METADATA = 'zendou:rate-limit-policy';

/**
 * Déclare la politique de limitation d'une route (ou d'un contrôleur entier).
 * Sans ce décorateur, la politique `DEFAULT` s'applique.
 *
 * ```ts
 * @Post('login')
 * @RateLimit(RATE_LIMIT_POLICY.LOGIN)
 * login() {}
 * ```
 */
export const RateLimit = (
  policy: RateLimitPolicyId,
): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_POLICY_METADATA, policy);

/**
 * Exempte totalement une route de la limitation.
 *
 * Réservé à `/health` : le `HEALTHCHECK` Docker l'appelle toutes les 30 s en
 * boucle. Compté, il finirait par saturer son propre quota et le conteneur
 * serait déclaré *unhealthy* — exactement l'inverse du but recherché.
 */
export const RateLimitExempt = (): MethodDecorator & ClassDecorator =>
  RateLimit(RATE_LIMIT_POLICY.EXEMPT);

/**
 * Lit la politique déclarée sur le handler, à défaut sur le contrôleur, à
 * défaut `DEFAULT`.
 *
 * Volontairement basée sur `Reflect` plutôt que sur `Reflector` : cette
 * fonction est appelée depuis les options du `ThrottlerModule`, où l'on ne
 * dispose pas forcément d'une instance injectée.
 */
export function readRateLimitPolicyId(
  context: ExecutionContext,
): RateLimitPolicyId {
  const fromHandler = readPolicyMetadata(context.getHandler());

  if (fromHandler) {
    return fromHandler;
  }

  return readPolicyMetadata(context.getClass()) ?? RATE_LIMIT_POLICY.DEFAULT;
}

function readPolicyMetadata(target: unknown): RateLimitPolicyId | undefined {
  if (typeof target !== 'function') {
    return undefined;
  }

  const value: unknown = Reflect.getMetadata(
    RATE_LIMIT_POLICY_METADATA,
    target,
  );

  return typeof value === 'string' ? (value as RateLimitPolicyId) : undefined;
}

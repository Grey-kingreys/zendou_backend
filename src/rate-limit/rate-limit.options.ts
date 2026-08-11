import { createHash } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type {
  ThrottlerModuleOptions,
  ThrottlerOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import type { RateLimitPolicyService } from './rate-limit-policy.service';
import type { RateLimitTrackerService } from './rate-limit-tracker.service';
import {
  HOUR_WINDOW_MS,
  MINUTE_WINDOW_MS,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_WINDOW,
} from './rate-limit.constants';
import { readRateLimitPolicyId } from './rate-limit.decorator';
import type { RateLimitRequest, RateLimitWindowName } from './rate-limit.types';

/** Sur quel identifiant un compteur donné s'appuie. */
type TrackerRole = 'primary' | 'secondary';

/**
 * Assemble les quatre compteurs déclarés à `@nestjs/throttler`.
 *
 * Chaque compteur est *conditionnel* : `skipIf` le désactive sur toute route
 * dont la politique ne prévoit pas cette fenêtre. Une route ne subit donc que
 * ses propres limites, et jamais l'empilement de toutes les fenêtres
 * déclarées globalement.
 */
export function buildThrottlerOptions(
  policyService: RateLimitPolicyService,
  trackerService: RateLimitTrackerService,
  storage: ThrottlerStorage,
): ThrottlerModuleOptions {
  const counter = (
    name: RateLimitWindowName,
    ttl: number,
    role: TrackerRole,
  ): ThrottlerOptions => ({
    name,
    ttl,
    limit: (context) =>
      policyService.windowFor(context, name)?.limit ??
      RATE_LIMIT_DEFAULTS.DEFAULT_PER_MINUTE,
    skipIf: (context) =>
      !applies(policyService, trackerService, context, name, role),
    getTracker: (request, context) => {
      const typed = request as RateLimitRequest;
      const kind = policyService.policyFor(context).tracker;

      return role === 'primary'
        ? trackerService.resolvePrimary(typed, kind)
        : (trackerService.resolveSecondary(typed, kind) ?? '');
    },
    generateKey,
    // Les en-têtes `X-RateLimit-*` de la bibliothèque seraient suffixés par
    // le nom du compteur (`X-RateLimit-Limit-minute`…). On préfère n'exposer
    // que le `Retry-After` canonique, posé par le garde sur le 429.
    setHeaders: false,
  });

  return {
    storage,
    throttlers: [
      counter(RATE_LIMIT_WINDOW.MINUTE, MINUTE_WINDOW_MS, 'primary'),
      counter(RATE_LIMIT_WINDOW.MINUTE_ALT, MINUTE_WINDOW_MS, 'secondary'),
      counter(RATE_LIMIT_WINDOW.HOUR, HOUR_WINDOW_MS, 'primary'),
      counter(RATE_LIMIT_WINDOW.HOUR_ALT, HOUR_WINDOW_MS, 'secondary'),
    ],
  };
}

/**
 * Un compteur s'applique si la politique de la route déclare cette fenêtre —
 * et, pour un compteur secondaire, si la requête porte effectivement un
 * identifiant secondaire (une connexion sans champ `email` n'a rien à
 * compter de ce côté-là).
 */
function applies(
  policyService: RateLimitPolicyService,
  trackerService: RateLimitTrackerService,
  context: ExecutionContext,
  name: RateLimitWindowName,
  role: TrackerRole,
): boolean {
  const policy = policyService.policyFor(context);

  if (policy.exempt || !policy.windows[name]) {
    return false;
  }

  if (role === 'primary') {
    return true;
  }

  const request = context
    .switchToHttp()
    .getRequest<RateLimitRequest | undefined>();

  return (
    request !== undefined &&
    trackerService.resolveSecondary(request, policy.tracker) !== undefined
  );
}

/**
 * Clé Redis d'un compteur.
 *
 * Volontairement indexée sur la **politique** et non sur le couple
 * contrôleur/handler comme le fait la bibliothèque : c'est ce qui donne son
 * sens au budget par défaut, qui est un budget *global* de 120 requêtes par
 * minute et par identité, et non 120 par route.
 *
 * L'identifiant est haché : ni email, ni empreinte de clé API, ni IP ne sont
 * écrits en clair dans Redis.
 */
export function generateKey(
  context: ExecutionContext,
  trackerString: string,
  throttlerName: string,
): string {
  return createHash('sha256')
    .update(
      `${readRateLimitPolicyId(context)}:${throttlerName}:${trackerString}`,
    )
    .digest('hex');
}

import type {
  RATE_LIMIT_POLICY,
  RATE_LIMIT_WINDOW,
  TRACKER_KIND,
} from './rate-limit.constants';

/** Identifiant de politique tel que posé par `@RateLimit(...)`. */
export type RateLimitPolicyId =
  (typeof RATE_LIMIT_POLICY)[keyof typeof RATE_LIMIT_POLICY];

/** Nom d'un compteur (fenêtre + identifiant principal ou secondaire). */
export type RateLimitWindowName =
  (typeof RATE_LIMIT_WINDOW)[keyof typeof RATE_LIMIT_WINDOW];

/** Nature de l'identifiant sur lequel une politique compte. */
export type TrackerKind = (typeof TRACKER_KIND)[keyof typeof TRACKER_KIND];

/** Une fenêtre de comptage résolue : `limit` requêtes par `ttl` millisecondes. */
export interface RateLimitWindow {
  readonly limit: number;
  readonly ttl: number;
}

/** Politique résolue (limites déjà lues depuis l'environnement). */
export interface ResolvedRateLimitPolicy {
  readonly id: RateLimitPolicyId;
  readonly tracker: TrackerKind;
  /** `true` pour `/health` : aucun compteur n'est touché. */
  readonly exempt: boolean;
  /** Fenêtres actives ; une fenêtre absente ne s'applique pas à la route. */
  readonly windows: Partial<Record<RateLimitWindowName, RateLimitWindow>>;
}

/**
 * Vue minimale et sûre de la requête Express dont la limitation a besoin.
 * Volontairement tout-optionnel : le garde s'exécute avant les gardes
 * d'authentification, donc `user`/`apiKeyId` sont normalement absents et
 * l'identité est reconstruite à partir du cookie ou du header.
 */
export interface RateLimitRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  method?: string;
  url?: string;
  originalUrl?: string;
  headers?: Record<string, unknown>;
  cookies?: unknown;
  body?: unknown;
  /** Posé par `SessionAuthGuard` (donc jamais vu par le garde global). */
  user?: { id?: string };
  /** Posé par `ApiKeyAuthGuard` (idem). */
  apiKeyId?: string;
}

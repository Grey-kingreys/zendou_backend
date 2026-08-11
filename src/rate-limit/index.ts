/**
 * Surface publique du module de limitation de débit.
 *
 * ⚠️ À n'importer que depuis `AppModule` ou des tests. Un **contrôleur** qui
 * poserait `@RateLimit(...)` via ce baril créerait un cycle
 * (`index → rate-limit.module → rate-limit-core.module → AuthModule →
 * contrôleur → index`) : à l'exécution, les constantes seraient encore
 * `undefined` au moment où le décorateur les lit. Les contrôleurs importent
 * donc directement `./rate-limit.constants` et `./rate-limit.decorator`, qui
 * sont des feuilles sans dépendance de module.
 */
export { RateLimitModule } from './rate-limit.module';
export { RateLimitCoreModule } from './rate-limit-core.module';
export { RateLimitGuard } from './rate-limit.guard';
export type { TooManyRequestsBody } from './rate-limit.guard';
export { RateLimitPolicyService } from './rate-limit-policy.service';
export { buildRateLimitPolicies } from './rate-limit-policy.service';
export { RateLimitTrackerService } from './rate-limit-tracker.service';
export { RedisThrottlerStorage } from './redis-throttler.storage';
export { buildThrottlerOptions } from './rate-limit.options';
export {
  RateLimit,
  RateLimitExempt,
  readRateLimitPolicyId,
  RATE_LIMIT_POLICY_METADATA,
} from './rate-limit.decorator';
export {
  DEFAULT_TRUST_PROXY_HOPS,
  HOUR_WINDOW_MS,
  MINUTE_WINDOW_MS,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_KEY_PREFIX,
  RATE_LIMIT_POLICY,
  RATE_LIMIT_REDIS,
  RATE_LIMIT_WINDOW,
  TOO_MANY_REQUESTS_MESSAGE,
  TRACKER_KIND,
} from './rate-limit.constants';
export {
  ipIdentifier,
  maskTracker,
  normalizeIp,
  resolveApiKeyIdentifier,
  resolveClientIp,
  resolveTargetEmail,
  trustProxySetting,
} from './rate-limit.identity';
export type {
  RateLimitPolicyId,
  RateLimitRequest,
  RateLimitWindow,
  RateLimitWindowName,
  ResolvedRateLimitPolicy,
  TrackerKind,
} from './rate-limit.types';

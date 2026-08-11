import { hashApiKey } from '../api-keys/api-key.utils';
import { extractBearerToken } from '../api-keys/api-key.utils';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import { UNKNOWN_IP } from './rate-limit.constants';
import type { RateLimitRequest } from './rate-limit.types';

/**
 * Fonctions pures d'extraction d'identité. Elles ne touchent ni Redis ni la
 * base : tout ce qu'elles savent, elles le lisent sur la requête. Testables
 * une par une, sans application Nest.
 */

/** Longueur conservée dans les logs pour un identifiant de compteur. */
const MASK_VISIBLE_LENGTH = 8;

/**
 * IP réelle du client.
 *
 * `req.ip` est calculée par Express **à partir de `X-Forwarded-For`** dès que
 * `trust proxy` est configuré (voir `trustProxySetting`). Sans cette
 * configuration, tous les clients derrière le proxy Dokploy/Traefik
 * partageraient l'IP du proxy et donc un unique compteur : la limitation
 * deviendrait un déni de service global.
 */
export function resolveClientIp(request: RateLimitRequest): string {
  const candidate =
    typeof request.ip === 'string' && request.ip.length > 0
      ? request.ip
      : request.socket?.remoteAddress;

  if (typeof candidate !== 'string' || candidate.length === 0) {
    return UNKNOWN_IP;
  }

  return normalizeIp(candidate);
}

/**
 * `::ffff:203.0.113.10` et `203.0.113.10` sont la même machine : sans
 * normalisation, un client obtiendrait deux compteurs distincts selon la
 * pile réseau du proxy.
 */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.startsWith('::ffff:')
    ? trimmed.slice('::ffff:'.length)
    : trimmed;
}

/**
 * Identifiant stable de la clé API présentée, ou `undefined`.
 *
 * Deux sources possibles :
 * - `request.apiKeyId`, posé par `ApiKeyAuthGuard` — mais ce garde s'exécute
 *   *après* le garde global de limitation, donc en pratique absent ;
 * - à défaut, l'empreinte SHA-256 de la clé du header `Authorization`.
 *   C'est exactement la forme déjà persistée en base (`ApiKey.keyHash`) :
 *   une correspondance 1-pour-1 avec la clé, sans secret en clair et sans
 *   requête SQL supplémentaire sur chaque appel entrant.
 */
export function resolveApiKeyIdentifier(
  request: RateLimitRequest,
): string | undefined {
  if (typeof request.apiKeyId === 'string' && request.apiKeyId.length > 0) {
    return `apikey:${request.apiKeyId}`;
  }

  const header = request.headers?.['authorization'];
  const key = extractBearerToken(
    typeof header === 'string' ? header : undefined,
  );

  return key ? `apikey:${hashApiKey(key)}` : undefined;
}

/** Identifiant d'utilisateur déjà résolu par un garde d'authentification. */
export function resolveResolvedUserIdentifier(
  request: RateLimitRequest,
): string | undefined {
  const id = request.user?.id;
  return typeof id === 'string' && id.length > 0 ? `user:${id}` : undefined;
}

/** Token de session brut porté par le cookie, ou `undefined`. */
export function readSessionToken(
  request: RateLimitRequest,
): string | undefined {
  const cookies = request.cookies;

  if (typeof cookies !== 'object' || cookies === null) {
    return undefined;
  }

  const token = (cookies as Record<string, unknown>)[SESSION_COOKIE_NAME];

  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Email visé par une requête non authentifiée (connexion, inscription),
 * normalisé pour que `Foo@Bar.COM ` et `foo@bar.com` partagent un compteur.
 */
export function resolveTargetEmail(
  request: RateLimitRequest,
): string | undefined {
  const body = request.body;

  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const email = (body as Record<string, unknown>).email;

  if (typeof email !== 'string') {
    return undefined;
  }

  const normalized = email.trim().toLowerCase();

  return normalized.length > 0 ? `email:${normalized}` : undefined;
}

/** Identifiant IP au format compteur. */
export function ipIdentifier(request: RateLimitRequest): string {
  return `ip:${resolveClientIp(request)}`;
}

/**
 * Forme loggable d'un identifiant de compteur : on garde le préfixe (qui dit
 * *sur quoi* on compte) et on tronque la valeur. Aucun email complet, aucune
 * empreinte de clé API entière, aucune IP complète ne part dans les logs.
 */
export function maskTracker(tracker: string): string {
  const separator = tracker.indexOf(':');

  if (separator < 0) {
    return truncate(tracker);
  }

  const kind = tracker.slice(0, separator);
  const value = tracker.slice(separator + 1);

  return `${kind}:${truncate(value)}`;
}

function truncate(value: string): string {
  return value.length > MASK_VISIBLE_LENGTH
    ? `${value.slice(0, MASK_VISIBLE_LENGTH)}…`
    : value;
}

/**
 * Traduit `TRUST_PROXY_HOPS` en valeur `trust proxy` d'Express.
 *
 * `0` désactive toute confiance (déploiement sans proxy : `X-Forwarded-For`
 * devient alors falsifiable et doit être ignoré). `n > 0` fait confiance aux
 * `n` derniers sauts, donc l'IP retenue est celle écrite par le proxy le plus
 * proche du client.
 */
export function trustProxySetting(hops: number): number | false {
  return Number.isFinite(hops) && hops > 0 ? Math.floor(hops) : false;
}

/**
 * « Continuer avec Google » (B30) - constantes de référence.
 */

/** Écran d'autorisation Google (OpenID Connect). */
export const GOOGLE_AUTHORIZATION_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';

/** Endpoint de jeton Google : échange du `code` contre l'`id_token`. */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Émetteurs acceptés dans le claim `iss` (documentation Google). */
export const GOOGLE_ISSUERS: readonly string[] = [
  'https://accounts.google.com',
  'accounts.google.com',
];

/** Portées demandées : identité de base, aucune vérification d'entreprise. */
export const GOOGLE_SCOPE = 'openid email profile';

/** Délai maximal de l'échange de jeton, en millisecondes. */
export const GOOGLE_TOKEN_TIMEOUT_MS = 10_000;

/** Tolérance d'horloge sur `exp`, en secondes. */
export const GOOGLE_CLOCK_SKEW_SECONDS = 60;

/** Cookie court qui lie le navigateur à l'état stocké côté serveur. */
export const GOOGLE_STATE_COOKIE_NAME = 'zendou_oauth';

/**
 * Chemin du cookie d'état : seules les deux routes Google le reçoivent
 * (`/v1/auth/google` et `/v1/auth/google/callback`).
 */
export const GOOGLE_STATE_COOKIE_PATH = '/v1/auth/google';

/** Durée de vie de l'état (Redis) et du cookie, en secondes : 10 minutes. */
export const GOOGLE_STATE_TTL_SECONDS = 600;

/**
 * Préfixe des clés Redis d'état : `oauth:google:<sha256(state)>`. L'état
 * lui-même n'entre jamais dans une clé.
 */
export const GOOGLE_STATE_KEY_PREFIX = 'oauth:google:';

/** Destination par défaut après connexion, et repli de tout `next` refusé. */
export const GOOGLE_DEFAULT_NEXT = '/dashboard';

/** Borne de longueur de `next` (borne d'entrée, pas de sens métier). */
export const GOOGLE_NEXT_MAX_LENGTH = 512;

/** Page du front qui affiche les erreurs de connexion. */
export const GOOGLE_ERROR_PAGE = '/connexion';

/**
 * Codes d'erreur renvoyés au front par `?erreur=<code>` (contrat B30).
 */
export const GOOGLE_ERROR = {
  /** Refus sur l'écran Google (`error=access_denied`). */
  CANCELLED: 'google_annule',
  /** État absent, expiré, déjà consommé ou différent du cookie. */
  SESSION_EXPIRED: 'google_session_expiree',
  /** `email_verified` n'est pas `true`. */
  EMAIL_NOT_VERIFIED: 'google_email_non_verifie',
  /** L'adresse appartient à un compte rattaché à un AUTRE compte Google. */
  ACCOUNT_CONFLICT: 'google_compte_conflit',
  /** Échange de jeton en échec, réponse illisible, ou fonction désactivée. */
  UNAVAILABLE: 'google_indisponible',
} as const;

export type GoogleErrorCode = (typeof GOOGLE_ERROR)[keyof typeof GOOGLE_ERROR];

/** 404 de `GET /v1/auth/google` quand la fonction n'est pas configurée. */
export const GOOGLE_DISABLED_MESSAGE =
  "La connexion avec Google n'est pas disponible.";

/** Nom du cookie de session posé sur le navigateur. */
export const SESSION_COOKIE_NAME = 'zendou_session';

/** Durée de vie d'une session (glissante) : 7 jours. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Préfixe des clés Redis stockant les sessions. */
export const SESSION_KEY_PREFIX = 'sess:';

/** Token d'injection du client Redis dédié aux sessions. */
export const SESSION_REDIS = 'AUTH_SESSION_REDIS';

/**
 * Message unique renvoyé pour tout échec d'authentification :
 * email inconnu et mot de passe faux sont indiscernables (pas d'oracle).
 */
export const INVALID_CREDENTIALS_MESSAGE = 'Email ou mot de passe incorrect';

/** Message renvoyé lorsqu'une adresse email est déjà enregistrée. */
export const EMAIL_ALREADY_USED_MESSAGE =
  'Cette adresse email est déjà utilisée';

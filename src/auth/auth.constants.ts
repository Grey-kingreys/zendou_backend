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

/** Message renvoyé quand `PATCH /v1/auth/me` reçoit un body sans aucun champ. */
export const NO_CHANGES_MESSAGE = 'Aucune modification fournie';

/**
 * Message renvoyé quand `currentPassword` fourni à
 * `POST /v1/auth/change-password` est incorrect.
 * Volontairement distinct de `INVALID_CREDENTIALS_MESSAGE` (login) :
 * ici l'utilisateur est déjà authentifié, son email est déjà connu de lui
 * comme du serveur, donc préciser que c'est le mot de passe qui est faux
 * ne permet aucune énumération de comptes.
 */
export const WRONG_CURRENT_PASSWORD_MESSAGE = 'Mot de passe actuel incorrect';

/** Message renvoyé quand le nouveau mot de passe est identique à l'actuel. */
export const SAME_PASSWORD_MESSAGE =
  "Le nouveau mot de passe doit être différent de l'actuel";

/**
 * Préfixe des clés Redis indexant, par utilisateur, l'ensemble des tokens de
 * session actifs : `usersess:<userId>` -> Set<token>. Permet de révoquer
 * toutes les sessions d'un utilisateur (ex. changement de mot de passe)
 * sans SCAN sur tout Redis.
 */
export const SESSION_USER_SET_PREFIX = 'usersess:';

/** Message renvoyé quand une clé API n'existe pas ou n'appartient pas au user courant. */
export const API_KEY_NOT_FOUND_MESSAGE = 'Clé API introuvable';

/** Message renvoyé par `ApiKeyAuthGuard` pour toute clé absente/inconnue/révoquée. */
export const INVALID_API_KEY_MESSAGE = 'Clé API invalide ou révoquée';

/** Message renvoyé par `ApiKeyAuthGuard` quand le propriétaire est suspendu. */
export const API_KEY_OWNER_SUSPENDED_MESSAGE = 'Ce compte est suspendu';

/** Message renvoyé quand on tente de supprimer une clé encore active. */
export const API_KEY_NOT_REVOKED_MESSAGE =
  'Seule une clé déjà révoquée peut être supprimée. Révoquez-la au préalable.';

/** Message renvoyé quand on tente de régénérer une clé révoquée. */
export const API_KEY_ROTATE_REVOKED_MESSAGE =
  'Une clé révoquée ne peut pas être régénérée.';

/**
 * Défaut de `RATE_LIMIT_API_KEY_FAILURES_PER_MINUTE` : échecs
 * d'authentification par clé API tolérés pour une même IP en une minute.
 *
 * 20 : un client qui se trompe de clé le voit tout de suite, un attaquant qui
 * essaie des clés au hasard est arrêté après vingt essais. Le compteur ne
 * porte que sur les ÉCHECS : une clé valide n'est jamais comptée, donc un
 * client légitime derrière le même NAT opérateur qu'un attaquant continue de
 * passer (voir `ApiKeyAuthGuard`).
 */
export const API_KEY_FAILURES_PER_MINUTE_DEFAULT = 20;

/** Fenêtre du compteur d'échecs par IP, et durée du blocage qui suit. */
export const API_KEY_FAILURE_WINDOW_MS = 60_000;

/** Préfixe des clés Redis du compteur d'échecs par IP. */
export const API_KEY_FAILURE_KEY_PREFIX = 'apikey-fail:';

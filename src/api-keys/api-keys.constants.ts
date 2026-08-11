/** Message renvoyé quand une clé API n'existe pas ou n'appartient pas au user courant. */
export const API_KEY_NOT_FOUND_MESSAGE = 'Clé API introuvable';

/** Message renvoyé par `ApiKeyAuthGuard` pour toute clé absente/inconnue/révoquée. */
export const INVALID_API_KEY_MESSAGE = 'Clé API invalide ou révoquée';

/** Message renvoyé par `ApiKeyAuthGuard` quand le propriétaire est suspendu. */
export const API_KEY_OWNER_SUSPENDED_MESSAGE = 'Ce compte est suspendu';

import { createHash, randomInt } from 'crypto';

/** Préfixe de toutes les clés API (environnement de production simulé). */
export const API_KEY_PREFIX = 'zd_live_';

/** Longueur de la partie aléatoire (base62) de la clé. */
const RANDOM_PART_LENGTH = 40;

/** Longueur du préfixe affiché (`zd_live_` + 4 caractères). */
export const API_KEY_DISPLAY_PREFIX_LENGTH = 12;

const BASE62_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export interface GeneratedApiKey {
  /** Clé complète (`zd_live_...`), à ne renvoyer qu'à la création. */
  key: string;
  /** 12 premiers caractères de la clé, sûrs à afficher/stocker en clair. */
  prefix: string;
  /** Empreinte SHA-256 (hex) de la clé complète, seule forme persistée. */
  keyHash: string;
}

/**
 * Génère une nouvelle clé API au format `zd_live_` + 40 caractères
 * aléatoires base62, tirés via un générateur cryptographiquement sûr.
 */
export function generateApiKey(): GeneratedApiKey {
  let random = '';
  for (let i = 0; i < RANDOM_PART_LENGTH; i++) {
    random += BASE62_ALPHABET[randomInt(BASE62_ALPHABET.length)];
  }

  const key = `${API_KEY_PREFIX}${random}`;

  return {
    key,
    prefix: key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH),
    keyHash: hashApiKey(key),
  };
}

/** Empreinte SHA-256 (hex) d'une clé API en clair. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Extrait la clé API d'un header `Authorization: Bearer zd_live_...`.
 * Renvoie `undefined` si le header est absent ou mal formé.
 */
export function extractBearerToken(
  authorizationHeader: string | undefined,
): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const [scheme, token] = authorizationHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return undefined;
  }

  return token;
}

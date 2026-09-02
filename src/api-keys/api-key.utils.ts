import { createHash, randomInt } from 'crypto';

/** Préfixe de toutes les clés API (environnement de production simulé). */
export const API_KEY_PREFIX = 'zd_live_';

/**
 * Longueur de la partie aléatoire (base62) de la clé.
 *
 * 43 caractères base62 = 43 x log2(62) ≈ 256 bits d'aléatoire, soit les 32
 * octets exigés par E3 (40 caractères n'en donnaient que 238). Le prefixe
 * affiché reste de 12 caractères : la clé s'allonge, pas ce qu'on en montre.
 */
const RANDOM_PART_LENGTH = 43;

/** Longueur du préfixe affiché (`zd_live_` + 4 caractères). */
export const API_KEY_DISPLAY_PREFIX_LENGTH = 12;

const BASE62_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export interface GeneratedApiKey {
  /** Clé complète (`zd_live_...`), à ne renvoyer qu'à la création. */
  key: string;
  /** 12 premiers caractères de la clé, sûrs à afficher/stocker en clair. */
  prefix: string;
  /**
   * Empreinte SHA-256 (hex) de la clé complète - la forme **historique**.
   *
   * Ce n'est plus forcément ce que persiste `ApiKeysService` : depuis E3, la
   * colonne `keyHash` reçoit `SecretHashingService.hashForStorage`, c'est-à-
   * dire un HMAC poivré dès qu'`API_KEY_PEPPER` est configurée. Ce champ reste
   * la forme historique, celle que `SecretHashingService` cherche en second
   * pour reconnaître une clé pas encore migrée.
   */
  keyHash: string;
}

/**
 * Tire `length` caractères aléatoires base62 via un générateur
 * cryptographiquement sûr. Factorisé hors de `generateApiKey` pour être
 * réutilisé tel quel par `smtp-credential.utils.ts` (même mécanique, secret
 * de forme différente) — voir §3.2 du plan B6.
 */
export function generateBase62Secret(length: number): string {
  let random = '';
  for (let i = 0; i < length; i++) {
    random += BASE62_ALPHABET[randomInt(BASE62_ALPHABET.length)];
  }
  return random;
}

/**
 * Génère une nouvelle clé API au format `zd_live_` + 43 caractères
 * aléatoires base62 (256 bits), tirés via un générateur cryptographiquement
 * sûr.
 */
export function generateApiKey(): GeneratedApiKey {
  const key = `${API_KEY_PREFIX}${generateBase62Secret(RANDOM_PART_LENGTH)}`;

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

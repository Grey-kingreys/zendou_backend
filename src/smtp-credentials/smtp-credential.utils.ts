import { randomBytes } from 'crypto';
import {
  API_KEY_DISPLAY_PREFIX_LENGTH,
  generateBase62Secret,
  hashApiKey,
} from '../api-keys/api-key.utils';

/** Préfixe de tous les identifiants SMTP (mot de passe). `zd_smtp_` fait 8
 * caractères, comme `zd_live_` — `API_KEY_DISPLAY_PREFIX_LENGTH` (12)
 * s'applique donc telle quelle (§3.2 du plan B6). */
export const SMTP_CREDENTIAL_SECRET_PREFIX = 'zd_smtp_';

/** Préfixe de tous les noms d'utilisateur SMTP générés (opaques). */
const SMTP_CREDENTIAL_USERNAME_PREFIX = 'zdu_';

/**
 * Longueur de la partie aléatoire (base62) du mot de passe SMTP. Même valeur
 * que `RANDOM_PART_LENGTH` d'`api-key.utils.ts` (43, soit 43 x log2(62) ≈ 256
 * bits, les 32 octets exigés par E3), mais c'est une décision de format
 * indépendante propre au secret SMTP - pas une valeur chaînée à celle des
 * clés API, donc pas importée.
 */
const RANDOM_PART_LENGTH = 43;

/** Nombre d'octets aléatoires du nom d'utilisateur opaque (→ 16 caractères hex). */
const USERNAME_RANDOM_BYTES = 8;

export interface GeneratedSmtpCredentialSecret {
  /** Mot de passe complet (`zd_smtp_...`), à ne renvoyer qu'à la création/rotation. */
  password: string;
  /** 12 premiers caractères du mot de passe, sûrs à afficher/stocker en clair. */
  prefix: string;
  /**
   * Empreinte SHA-256 (hex) du mot de passe complet - la forme
   * **historique**. Depuis E3, `SmtpCredentialsService` persiste
   * `SecretHashingService.hashForStorage` (HMAC poivré si `API_KEY_PEPPER`
   * est configurée) ; ce champ reste la forme historique, celle sous laquelle
   * un secret pas encore migré est reconnu.
   */
  passwordHash: string;
}

/**
 * Génère un nouveau secret d'identifiant SMTP au format `zd_smtp_` + 43
 * caractères aléatoires base62 (256 bits).
 *
 * **Même mécanique que `generateApiKey`, réutilisée et non réécrite** :
 * `generateBase62Secret` (tirage cryptographique), `hashApiKey` (hash
 * SHA-256, via `hashSmtpCredentialSecret` ci-dessous) et
 * `API_KEY_DISPLAY_PREFIX_LENGTH` viennent tous d'`api-key.utils.ts`.
 */
export function generateSmtpCredentialSecret(): GeneratedSmtpCredentialSecret {
  const password = `${SMTP_CREDENTIAL_SECRET_PREFIX}${generateBase62Secret(RANDOM_PART_LENGTH)}`;

  return {
    password,
    prefix: password.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH),
    passwordHash: hashSmtpCredentialSecret(password),
  };
}

/**
 * Empreinte SHA-256 (hex) d'un secret SMTP en clair — délègue à `hashApiKey`,
 * qui est déjà générique (SHA-256 hex de n'importe quelle chaîne) : rien à
 * réécrire, seulement à réutiliser sous un nom propre au domaine SMTP.
 */
export function hashSmtpCredentialSecret(secret: string): string {
  return hashApiKey(secret);
}

/**
 * Génère un nom d'utilisateur SMTP opaque (`zdu_` + 16 hex) — jamais
 * l'adresse email du compte (§3.2 du plan B6). N'a pas d'équivalent côté
 * `ApiKey` (les clés API n'ont pas de nom d'utilisateur) : code propre à ce
 * module, pas de réutilisation possible.
 */
export function generateSmtpCredentialUsername(): string {
  return `${SMTP_CREDENTIAL_USERNAME_PREFIX}${randomBytes(USERNAME_RANDOM_BYTES).toString('hex')}`;
}

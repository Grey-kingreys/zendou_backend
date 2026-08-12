/** Valeur inscrite dans `CreditEntry.reason` lors d'une recharge approuvée. */
export const CREDIT_REASON_TOPUP = 'TOPUP';

/**
 * Valeur inscrite dans `CreditEntry.reason` lors de l'octroi du crédit de
 * bienvenue, à la confirmation de l'adresse email.
 *
 * Motif **dédié**, et surtout ni `TOPUP` ni `ADMIN_GRANT` : ces crédits sont
 * offerts, ils n'ont donné lieu à aucun encaissement. Les confondre avec une
 * recharge payée ferait compter du cadeau comme du revenu dans les KPI de
 * l'espace admin et fausserait le calcul de marge — d'autant plus que le
 * montant (1 000 par compte par défaut) écrase les premiers vrais paiements.
 * Toute agrégation « chiffre d'affaires » doit donc exclure ce motif.
 */
export const CREDIT_REASON_WELCOME_BONUS = 'WELCOME_BONUS';

/**
 * Montant par défaut du crédit de bienvenue, surchargeable par la variable
 * d'environnement `WELCOME_CREDITS` (cahier §12 : la grille tarifaire n'est
 * pas finale).
 */
export const DEFAULT_WELCOME_CREDITS = 1_000;

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export const TRANSACTION_REF_MIN_LENGTH = 4;
export const TRANSACTION_REF_MAX_LENGTH = 64;

/** Format guinéen souple : chiffres, espaces et « + » uniquement. */
export const PHONE_ALLOWED_CHARS_REGEX = /^[0-9+\s]+$/;
export const PHONE_MIN_DIGITS = 8;
export const PHONE_MAX_DIGITS = 15;

export const PACK_NOT_FOUND_MESSAGE = 'Pack de crédits inconnu.';
export const PACK_NOT_PURCHASABLE_MESSAGE =
  "Ce pack n'est pas disponible à l'achat.";
export const INVALID_METHOD_MESSAGE = 'Méthode de paiement invalide.';
export const INVALID_PHONE_MESSAGE =
  'Numéro de téléphone invalide : utilisez uniquement des chiffres, espaces et « + », avec 8 à 15 chiffres.';
export const TRANSACTION_REF_LENGTH_MESSAGE = `La référence de transaction doit contenir entre ${TRANSACTION_REF_MIN_LENGTH} et ${TRANSACTION_REF_MAX_LENGTH} caractères.`;
export const DUPLICATE_TRANSACTION_REF_MESSAGE =
  'Une demande est déjà en attente avec cette référence de transaction.';

export const TOPUP_REQUEST_NOT_FOUND_MESSAGE =
  'Demande de recharge introuvable.';
export const TOPUP_REQUEST_ALREADY_REVIEWED_MESSAGE =
  'Cette demande a déjà été traitée.';

export const ADMIN_FORBIDDEN_MESSAGE = 'Réservé aux administrateurs.';

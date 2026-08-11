/** Valeur inscrite dans `CreditEntry.reason` lors d'une recharge approuvée. */
export const CREDIT_REASON_TOPUP = 'TOPUP';

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

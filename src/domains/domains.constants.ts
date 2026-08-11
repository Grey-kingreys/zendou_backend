/**
 * Nom de domaine en minuscules : labels alphanumériques séparés par des
 * points, au moins un point, TLD alphabétique d'au moins 2 caractères.
 * Rejette donc les protocoles (`http://x.com`), les noms sans point
 * (`pas-de-point`) et les adresses IP (`1.2.3.4`).
 */
export const DOMAIN_NAME_REGEX =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Longueur maximale d'un nom de domaine complet (RFC 1035). */
export const DOMAIN_NAME_MAX_LENGTH = 253;

/** Message renvoyé pour un nom de domaine syntaxiquement invalide. */
export const INVALID_DOMAIN_NAME_MESSAGE =
  'Nom de domaine invalide : indiquez un domaine comme « boutique-awa.gn », sans « http:// » ni adresse IP.';

/**
 * Message renvoyé lorsqu'un domaine est déjà enregistré. Volontairement
 * neutre : il ne révèle pas qu'un autre client détient ce domaine.
 */
export const DOMAIN_ALREADY_REGISTERED_MESSAGE =
  'Ce domaine est déjà enregistré.';

/** Message renvoyé lorsqu'un domaine n'existe pas ou appartient à autrui. */
export const DOMAIN_NOT_FOUND_MESSAGE = 'Domaine introuvable';

/** Suffixe des CNAME DKIM fournis par Amazon SES. */
export const DKIM_CNAME_SUFFIX = 'dkim.amazonses.com';

/** Valeur SPF recommandée pour autoriser Amazon SES. */
export const SPF_RECORD_VALUE = 'v=spf1 include:amazonses.com ~all';

/** Valeur DMARC recommandée pour démarrer en mode observation. */
export const DMARC_RECORD_VALUE = 'v=DMARC1; p=none;';

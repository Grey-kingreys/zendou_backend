/** Nombre maximal d'en-têtes personnalisés par envoi. */
export const MAX_CUSTOM_HEADERS = 20;

/** Longueur maximale d'une valeur d'en-tête (limite de ligne de la RFC 5322). */
export const MAX_HEADER_VALUE_LENGTH = 998;

/** En-têtes nommés autorisés, en minuscules. Le reste passe par `X-*`. */
const ALLOWED_HEADER_NAMES = new Set([
  'list-unsubscribe',
  'list-unsubscribe-post',
]);

/** Préfixe réservé à SES : jamais autorisé, même sous la forme `X-*`. */
const RESERVED_HEADER_PREFIX = 'x-ses-';

/** Nom de champ RFC 5322 : caractères imprimables, sans « : » ni espace. */
const HEADER_NAME_PATTERN = /^[\x21-\x39\x3B-\x7E]+$/;

export const INVALID_HEADERS_MESSAGE =
  'Le champ « headers » doit être un objet de la forme { "X-Nom": "valeur" }.';

export const TOO_MANY_HEADERS_MESSAGE = `Le champ « headers » accepte ${MAX_CUSTOM_HEADERS} en-têtes au maximum.`;

export const headerNameInvalidMessage = (name: string): string =>
  `Le nom d'en-tête « ${name} » est invalide : utilisez des caractères imprimables, sans « : » ni espace.`;

export const headerNameForbiddenMessage = (name: string): string =>
  `L'en-tête « ${name} » n'est pas autorisé. Seuls List-Unsubscribe, List-Unsubscribe-Post et les en-têtes X-* (hors X-SES-*) peuvent être personnalisés.`;

export const headerDuplicateMessage = (name: string): string =>
  `L'en-tête « ${name} » est fourni plusieurs fois (les noms d'en-tête ne tiennent pas compte de la casse).`;

export const headerValueInvalidMessage = (name: string): string =>
  `La valeur de l'en-tête « ${name} » doit être une chaîne non vide, sans saut de ligne, de ${MAX_HEADER_VALUE_LENGTH} caractères au maximum.`;

/**
 * Valide les en-têtes personnalisés d'un envoi API. Rend le premier message
 * d'erreur (français) ou `null` si tout est acceptable.
 *
 * Liste blanche, jamais liste noire : `From`, `To`, `Subject`, `Reply-To`,
 * `DKIM-Signature`, `Content-*`, `Message-ID`... restent composés par Zendou
 * et SES. Les valeurs sans CR ni LF écartent l'injection d'en-tête.
 */
export function validateCustomHeaders(headers: unknown): string | null {
  if (
    typeof headers !== 'object' ||
    headers === null ||
    Array.isArray(headers)
  ) {
    return INVALID_HEADERS_MESSAGE;
  }

  const entries = Object.entries(headers);

  if (entries.length > MAX_CUSTOM_HEADERS) {
    return TOO_MANY_HEADERS_MESSAGE;
  }

  const seen = new Set<string>();

  for (const [name, value] of entries) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      return headerNameInvalidMessage(name);
    }

    const lower = name.toLowerCase();
    const allowed =
      ALLOWED_HEADER_NAMES.has(lower) ||
      (lower.startsWith('x-') && !lower.startsWith(RESERVED_HEADER_PREFIX));

    if (!allowed) {
      return headerNameForbiddenMessage(name);
    }

    if (seen.has(lower)) {
      return headerDuplicateMessage(name);
    }
    seen.add(lower);

    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.length > MAX_HEADER_VALUE_LENGTH ||
      /[\r\n]/.test(value)
    ) {
      return headerValueInvalidMessage(name);
    }
  }

  return null;
}

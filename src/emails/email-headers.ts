/** Nombre maximal d'en-têtes personnalisés par envoi. */
export const MAX_CUSTOM_HEADERS = 20;

/** Longueur maximale d'une valeur d'en-tête (limite de SES, `MessageHeader`). */
export const MAX_HEADER_VALUE_LENGTH = 995;

/** Longueur maximale d'un nom d'en-tête (limite de SES). */
export const MAX_HEADER_NAME_LENGTH = 126;

/** Longueur maximale du nom et de la valeur réunis (limite de SES). */
export const MAX_HEADER_TOTAL_LENGTH = 996;

/**
 * Valeur d'en-tête : ASCII imprimable seulement, comme l'exige SES. Exclut
 * aussi CR, LF et NUL (injection d'en-tête).
 */
const HEADER_VALUE_PATTERN = /^[\x20-\x7E]+$/;

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

export const headerNameTooLongMessage = (name: string): string =>
  `Le nom d'en-tête « ${name.slice(0, 40)}... » dépasse ${MAX_HEADER_NAME_LENGTH} caractères.`;

export const headerValueInvalidMessage = (name: string): string =>
  `La valeur de l'en-tête « ${name} » doit être une chaîne non vide, en ASCII imprimable (ni accent, ni saut de ligne, ni caractère de contrôle), de ${MAX_HEADER_VALUE_LENGTH} caractères au maximum.`;

export const headerTooLongMessage = (name: string): string =>
  `L'en-tête « ${name} » est trop long : le nom et la valeur réunis ne doivent pas dépasser ${MAX_HEADER_TOTAL_LENGTH} caractères.`;

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

    if (name.length > MAX_HEADER_NAME_LENGTH) {
      return headerNameTooLongMessage(name);
    }

    const lower = name.toLowerCase();
    const allowed =
      ALLOWED_HEADER_NAMES.has(lower) ||
      // Au moins un caractère après « x- » : « X- » seul n'est pas un nom.
      (lower.startsWith('x-') &&
        lower.length > 2 &&
        !lower.startsWith(RESERVED_HEADER_PREFIX));

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
      !HEADER_VALUE_PATTERN.test(value)
    ) {
      return headerValueInvalidMessage(name);
    }

    if (name.length + value.length > MAX_HEADER_TOTAL_LENGTH) {
      return headerTooLongMessage(name);
    }
  }

  return null;
}

import {
  DOMAIN_NAME_MAX_LENGTH,
  DOMAIN_NAME_REGEX,
} from '../domains/domains.constants';

/** Longueur maximale d'une adresse email complète (RFC 5321). */
export const EMAIL_ADDRESS_MAX_LENGTH = 254;

/** Longueur maximale de la partie locale d'une adresse (RFC 5321). */
const LOCAL_PART_MAX_LENGTH = 64;

/**
 * Partie locale au format « dot-atom » (RFC 5322) : des caractères atom
 * séparés par des points, sans point en tête, en fin, ni doublé. Les
 * parties locales entre guillemets ne sont pas acceptées.
 */
const LOCAL_PART_REGEX =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;

/**
 * Forme `Nom <adresse@domaine>` : le chevron fermant doit terminer la
 * chaîne, ce qui rejette « Nom <a@b.gn> autre chose ».
 */
const NAMED_ADDRESS_REGEX = /^(.*?)<([^<>]*)>$/;

/** Caractères qui obligent à mettre le nom d'affichage entre guillemets. */
const NAME_NEEDS_QUOTES_REGEX = /["(),:;<>@[\\\]]/;

/** Adresse d'expédition analysée. */
export interface ParsedAddress {
  /** Nom d'affichage, absent lorsque l'adresse est fournie nue. */
  name?: string;
  /** Adresse normalisée en minuscules. */
  address: string;
  /** Domaine de l'adresse, en minuscules. */
  domain: string;
}

/**
 * Normalise une adresse nue (`adresse@domaine`) et la valide.
 * Renvoie `null` si l'adresse est syntaxiquement invalide.
 *
 * L'adresse est ramenée en minuscules : la casse de la partie locale est
 * théoriquement significative, mais aucun fournisseur courant ne la
 * distingue et cela rend la liste de suppression déterministe.
 */
export function normalizeEmailAddress(raw: string): string | null {
  const trimmed = raw.trim();

  if (!trimmed || trimmed.length > EMAIL_ADDRESS_MAX_LENGTH) {
    return null;
  }

  // `lastIndexOf` : une partie locale contenant un « @ » est de toute
  // façon rejetée ensuite par `LOCAL_PART_REGEX` (cas « a@@b.gn »).
  const separator = trimmed.lastIndexOf('@');

  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  const local = trimmed.slice(0, separator);
  const domain = trimmed.slice(separator + 1).toLowerCase();

  if (local.length > LOCAL_PART_MAX_LENGTH || !LOCAL_PART_REGEX.test(local)) {
    return null;
  }

  if (
    domain.length > DOMAIN_NAME_MAX_LENGTH ||
    !DOMAIN_NAME_REGEX.test(domain)
  ) {
    return null;
  }

  return `${local.toLowerCase()}@${domain}`;
}

/**
 * Analyse une adresse d'expédition dans ses deux formes acceptées :
 * `adresse@domaine` et `Nom <adresse@domaine>` (le nom pouvant être entre
 * guillemets). Renvoie `null` si la chaîne n'est ni l'une ni l'autre.
 */
export function parseEmailAddress(raw: string): ParsedAddress | null {
  const trimmed = raw.trim();

  if (!trimmed) {
    return null;
  }

  const named = NAMED_ADDRESS_REGEX.exec(trimmed);
  const address = normalizeEmailAddress(named ? named[2] : trimmed);

  if (!address) {
    return null;
  }

  const domain = address.slice(address.lastIndexOf('@') + 1);
  const name = named ? unquoteDisplayName(named[1].trim()) : '';

  return name ? { name, address, domain } : { address, domain };
}

/**
 * Reconstruit la forme canonique d'une adresse analysée, en remettant le
 * nom d'affichage entre guillemets s'il contient des caractères spéciaux.
 */
export function formatEmailAddress(parsed: ParsedAddress): string {
  if (!parsed.name) {
    return parsed.address;
  }

  const name = NAME_NEEDS_QUOTES_REGEX.test(parsed.name)
    ? `"${parsed.name.replace(/(["\\])/g, '\\$1')}"`
    : parsed.name;

  return `${name} <${parsed.address}>`;
}

/** Retire les guillemets encadrant un nom d'affichage et les échappements. */
function unquoteDisplayName(name: string): string {
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    return name.slice(1, -1).replace(/\\(.)/g, '$1').trim();
  }

  return name;
}

/** Taille maximale d'un mot encodé RFC 2047 (§2), délimiteurs compris. */
const ENCODED_WORD_MAX_LENGTH = 75;

/** `=?UTF-8?B?` + `?=` : 12 caractères de délimiteurs. */
const ENCODED_WORD_OVERHEAD = 12;

/** Octets UTF-8 maximaux par mot : base64 par groupes de 4 (3 octets). */
const ENCODED_WORD_MAX_BYTES =
  Math.floor((ENCODED_WORD_MAX_LENGTH - ENCODED_WORD_OVERHEAD) / 4) * 3;

/**
 * Encode un nom d'affichage en mots encodés `=?UTF-8?B?...?=` (RFC 2047),
 * découpés à 75 caractères au plus, sans jamais couper un caractère UTF-8.
 */
function encodeDisplayName(name: string): string {
  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;

  for (const char of name) {
    const bytes = Buffer.byteLength(char, 'utf8');

    if (chunkBytes + bytes > ENCODED_WORD_MAX_BYTES) {
      words.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }

    chunk += char;
    chunkBytes += bytes;
  }

  if (chunk) {
    words.push(chunk);
  }

  return words
    .map(
      (word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`,
    )
    .join(' ');
}

/**
 * Adresse prête pour SES en contenu Simple. SES exige qu'un nom d'affichage
 * non ASCII soit un mot encodé RFC 2047 ; un nom ASCII, nu ou entre guillemets,
 * et une adresse nue sont rendus tels quels. Ne sert pas au contenu Raw, où le
 * client fournit son propre MIME.
 */
export function toSesAddress(formatted: string): string {
  const parsed = parseEmailAddress(formatted);

  if (!parsed?.name || /^[\x20-\x7E]*$/.test(parsed.name)) {
    return formatted;
  }

  return `${encodeDisplayName(parsed.name)} <${parsed.address}>`;
}

import { DOMAIN_NAME_MAX_LENGTH, DOMAIN_NAME_REGEX } from './domains.constants';

/** Met le nom de domaine en forme canonique : sans espaces, en minuscules. */
export function normalizeDomainName(name: string): string {
  return name.trim().toLowerCase();
}

/** Vérifie qu'un nom déjà normalisé est un nom de domaine plausible. */
export function isValidDomainName(name: string): boolean {
  return name.length <= DOMAIN_NAME_MAX_LENGTH && DOMAIN_NAME_REGEX.test(name);
}

import type { CookieOptions, Request } from 'express';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from './auth.constants';

type BaseCookieOptions = Required<
  Pick<CookieOptions, 'httpOnly' | 'sameSite' | 'path' | 'secure'>
> &
  Pick<CookieOptions, 'domain'>;

/**
 * Attributs du cookie de session hors durée de vie.
 * Doivent être identiques à la pose et à la suppression pour que le
 * navigateur reconnaisse le même cookie.
 *
 * `domain` (`SESSION_COOKIE_DOMAIN`) est **omis** quand la variable n'est pas
 * configurée : un cookie sans attribut `Domain` est un cookie *hôte-seul*,
 * lisible par le seul hôte qui l'a posé. C'est le comportement historique, et
 * il reste le défaut - poser un domaine élargit la portée du cookie, ce qui ne
 * doit jamais arriver par accident.
 */
export function baseSessionCookieOptions(
  isProduction: boolean,
  domain?: string,
): BaseCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isProduction,
    ...(domain ? { domain } : {}),
  };
}

/** Options complètes utilisées lors de la pose du cookie de session. */
export function sessionCookieOptions(
  isProduction: boolean,
  domain?: string,
): CookieOptions {
  return {
    ...baseSessionCookieOptions(isProduction, domain),
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}

/** Lecture typée du token de session depuis les cookies parsés. */
export function readSessionCookie(request: Request): string | undefined {
  const cookies: unknown = request.cookies;

  if (typeof cookies !== 'object' || cookies === null) {
    return undefined;
  }

  const token = (cookies as Record<string, unknown>)[SESSION_COOKIE_NAME];

  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

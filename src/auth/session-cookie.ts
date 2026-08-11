import type { CookieOptions, Request } from 'express';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from './auth.constants';

type BaseCookieOptions = Required<
  Pick<CookieOptions, 'httpOnly' | 'sameSite' | 'path' | 'secure'>
>;

/**
 * Attributs du cookie de session hors durée de vie.
 * Doivent être identiques à la pose et à la suppression pour que le
 * navigateur reconnaisse le même cookie.
 */
export function baseSessionCookieOptions(
  isProduction: boolean,
): BaseCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isProduction,
  };
}

/** Options complètes utilisées lors de la pose du cookie de session. */
export function sessionCookieOptions(isProduction: boolean): CookieOptions {
  return {
    ...baseSessionCookieOptions(isProduction),
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

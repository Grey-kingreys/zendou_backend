import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import { RATE_LIMIT_POLICY } from '../rate-limit/rate-limit.constants';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { SESSION_COOKIE_NAME } from './auth.constants';
import { AuthService } from './auth.service';
import {
  GOOGLE_DISABLED_MESSAGE,
  GOOGLE_ERROR,
  GOOGLE_ERROR_PAGE,
  GOOGLE_STATE_COOKIE_NAME,
  GOOGLE_STATE_COOKIE_PATH,
  GOOGLE_STATE_TTL_SECONDS,
  type GoogleErrorCode,
} from './google-oauth.constants';
import {
  GoogleAuthError,
  GoogleOAuthService,
  statesMatch,
} from './google-oauth.service';
import { sessionCookieOptions } from './session-cookie';

/** Réponse de `GET /v1/auth/providers`. */
export interface AuthProvidersResult {
  google: boolean;
}

/**
 * « Continuer avec Google » (B30) et liste des moyens de connexion.
 *
 * Contrôleur distinct d'`AuthController` : ces routes répondent par des
 * redirections de navigateur, pas par du JSON, et n'ont besoin ni du captcha
 * ni de la confirmation d'adresse.
 */
@Controller('auth')
export class GoogleAuthController {
  private readonly logger = new Logger(GoogleAuthController.name);
  private readonly isProduction: boolean;
  private readonly cookieDomain: string | undefined;
  private readonly appBaseUrl: string;

  constructor(
    private readonly authService: AuthService,
    private readonly googleOAuth: GoogleOAuthService,
    configService: ConfigService,
  ) {
    this.isProduction = configService.get<string>('NODE_ENV') === 'production';
    this.cookieDomain = configService.get<string>('SESSION_COOKIE_DOMAIN');
    // `APP_BASE_URL` est obligatoire quand Google est configuré
    // (`env.schema.ts`). Le repli sur `FRONTEND_ORIGIN` ne sert qu'à la
    // redirection `google_indisponible` quand la fonction est désactivée.
    const base =
      configService.get<string>('APP_BASE_URL') ??
      configService.get<string>('FRONTEND_ORIGIN') ??
      '';
    this.appBaseUrl = base.replace(/\/+$/, '');
  }

  /**
   * Moyens de connexion disponibles, lus au runtime par le front (jamais par
   * une variable `NEXT_PUBLIC_*` figée au build). Public.
   */
  @Get('providers')
  @HttpCode(HttpStatus.OK)
  providers(): AuthProvidersResult {
    return { google: this.googleOAuth.isEnabled() };
  }

  /**
   * Départ vers Google. 302 vers l'écran d'autorisation, cookie d'état posé.
   * Fonction désactivée : 404 au format d'erreur standard.
   */
  @Get('google')
  @RateLimit(RATE_LIMIT_POLICY.GOOGLE_AUTH)
  async start(@Req() request: Request, @Res() response: Response) {
    if (!this.googleOAuth.isEnabled()) {
      throw new NotFoundException(GOOGLE_DISABLED_MESSAGE);
    }

    let state: string;
    let authorizationUrl: string;

    try {
      ({ state, authorizationUrl } = await this.googleOAuth.start(
        request.query.next,
      ));
    } catch (error) {
      this.logger.error(
        "Départ vers Google impossible (stockage de l'état en échec)",
        error instanceof Error ? error.stack : String(error),
      );
      return this.redirectToError(response, GOOGLE_ERROR.UNAVAILABLE);
    }

    response.cookie(GOOGLE_STATE_COOKIE_NAME, state, {
      ...this.stateCookieOptions(),
      maxAge: GOOGLE_STATE_TTL_SECONDS * 1000,
    });
    response.redirect(HttpStatus.FOUND, authorizationUrl);
  }

  /**
   * Rappel de Google. Succès : session posée (mêmes attributs que le login),
   * 302 vers `${APP_BASE_URL}${next}`. Échec : 302 vers
   * `${APP_BASE_URL}/connexion?erreur=<code>`. Le cookie d'état est effacé
   * dans tous les cas.
   */
  @Get('google/callback')
  @RateLimit(RATE_LIMIT_POLICY.GOOGLE_AUTH)
  async callback(@Req() request: Request, @Res() response: Response) {
    response.clearCookie(GOOGLE_STATE_COOKIE_NAME, this.stateCookieOptions());

    if (!this.googleOAuth.isEnabled()) {
      return this.redirectToError(response, GOOGLE_ERROR.UNAVAILABLE);
    }

    try {
      const next = await this.handleCallback(request, response);
      response.redirect(HttpStatus.FOUND, `${this.appBaseUrl}${next}`);
    } catch (error) {
      if (error instanceof GoogleAuthError) {
        this.googleOAuth.logFailure(error);
        return this.redirectToError(response, error.code);
      }

      // Panne imprévue (base, Redis) : un navigateur ne doit pas atterrir sur
      // un 500 JSON au milieu d'une redirection.
      this.logger.error(
        'Rappel Google en échec (erreur interne)',
        error instanceof Error ? error.stack : String(error),
      );
      return this.redirectToError(response, GOOGLE_ERROR.UNAVAILABLE);
    }
  }

  /** Déroule le rappel ; rend le chemin de destination ou lève `GoogleAuthError`. */
  private async handleCallback(
    request: Request,
    response: Response,
  ): Promise<string> {
    const query = request.query;
    const queryState = typeof query.state === 'string' ? query.state : '';
    const cookieState = readStateCookie(request);

    // Le `state` de la requête doit être celui que CE navigateur a reçu au
    // départ (cookie), comparé à temps constant. Sans cela, un attaquant
    // pourrait faire aboutir chez la victime un parcours qu'il a lui-même
    // commencé (connexion forcée à son compte).
    const stateMatches =
      queryState.length > 0 &&
      cookieState !== undefined &&
      statesMatch(queryState, cookieState);

    // Consommé seulement si le cookie concorde : une requête forgée ne peut
    // pas brûler l'état d'un parcours légitime.
    const stored = stateMatches
      ? await this.googleOAuth.consumeState(queryState)
      : null;

    // Refus sur l'écran Google : le parcours est terminé, quel que soit
    // l'état. Google renvoie `access_denied` ; toute autre erreur est une
    // indisponibilité de son côté.
    if (typeof query.error === 'string') {
      throw new GoogleAuthError(
        query.error === 'access_denied'
          ? GOOGLE_ERROR.CANCELLED
          : GOOGLE_ERROR.UNAVAILABLE,
        `erreur renvoyée par Google : ${query.error.slice(0, 64)}`,
      );
    }

    if (!stored) {
      throw new GoogleAuthError(
        GOOGLE_ERROR.SESSION_EXPIRED,
        stateMatches
          ? 'état inconnu, expiré ou déjà consommé'
          : 'état absent ou différent du cookie',
      );
    }

    if (typeof query.code !== 'string' || query.code.length === 0) {
      throw new GoogleAuthError(
        GOOGLE_ERROR.UNAVAILABLE,
        "code d'autorisation absent",
      );
    }

    const identity = await this.googleOAuth.fetchIdentity(query.code, stored);
    const { token } = await this.authService.loginWithGoogle(identity);

    response.cookie(
      SESSION_COOKIE_NAME,
      token,
      sessionCookieOptions(this.isProduction, this.cookieDomain),
    );

    return stored.next;
  }

  private redirectToError(response: Response, code: GoogleErrorCode): void {
    response.redirect(
      HttpStatus.FOUND,
      `${this.appBaseUrl}${GOOGLE_ERROR_PAGE}?erreur=${code}`,
    );
  }

  /**
   * Attributs du cookie d'état, identiques à la pose et à l'effacement.
   * Hôte seul (pas de `Domain`) : seule l'API le lit. `Path` limité aux deux
   * routes Google. `SameSite=Lax` : le rappel est une navigation de premier
   * niveau venue de Google, que `Lax` laisse passer.
   */
  private stateCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      path: GOOGLE_STATE_COOKIE_PATH,
    };
  }
}

function readStateCookie(request: Request): string | undefined {
  const cookies: unknown = request.cookies;

  if (typeof cookies !== 'object' || cookies === null) {
    return undefined;
  }

  const value = (cookies as Record<string, unknown>)[GOOGLE_STATE_COOKIE_NAME];

  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

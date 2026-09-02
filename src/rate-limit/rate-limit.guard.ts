import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { RateLimitPolicyService } from './rate-limit-policy.service';
import {
  RATE_LIMIT_HEADERS,
  TOO_MANY_REQUESTS_MESSAGE,
} from './rate-limit.constants';
import { maskTracker } from './rate-limit.identity';

/** Corps JSON renvoyé sur dépassement. */
export interface TooManyRequestsBody {
  statusCode: number;
  error: string;
  message: string;
  /** Secondes à attendre — même valeur que l'en-tête `Retry-After`. */
  retryAfter: number;
}

/**
 * Garde global de limitation de débit.
 *
 * Ne réécrit pas la mécanique de comptage de `@nestjs/throttler` : il n'en
 * change que trois choses.
 * 1. `shouldSkip` — court-circuite les routes exemptées (`/health`).
 * 2. `throwThrottlingException` — réponse 429 en français, en-tête
 *    `Retry-After` canonique (la bibliothèque, quand plusieurs compteurs sont
 *    nommés, produirait `Retry-After-minute`, que personne ne lit), et trace
 *    WARN.
 * 3. `handleRequest` : même séquence que la bibliothèque, mais les en-têtes
 *    `X-RateLimit-*` sont posés sans suffixe de compteur (voir
 *    {@link RATE_LIMIT_HEADERS}), d'où le `setHeaders: false` des options.
 * Le choix de l'identifiant compté et des fenêtres se fait, lui, dans les
 * options du module (`rate-limit.module.ts`).
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  private readonly rateLimitLogger = new Logger(RateLimitGuard.name);

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly policyService: RateLimitPolicyService,
  ) {
    super(options, storageService, reflector);
  }

  /**
   * `/health` n'est jamais compté : le `HEALTHCHECK` Docker le frappe en
   * boucle et finirait par épuiser son propre quota, ce qui déclarerait le
   * conteneur *unhealthy* — l'exact inverse du but recherché.
   */
  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return Promise.resolve(true);
    }

    return Promise.resolve(this.policyService.isExempt(context));
  }

  /**
   * Reprend pas à pas la séquence de la bibliothèque - identifiant compté,
   * clé, incrément atomique, exception si le compteur est bloqué - et y ajoute
   * les en-têtes de débit.
   *
   * Réécrite plutôt que complétée après coup parce que `handleRequest` est le
   * seul endroit où l'on dispose à la fois du compteur qui vient d'être
   * incrémenté et de la réponse HTTP : le garde est appelé une fois par
   * compteur applicable, et chaque appel doit pouvoir corriger l'en-tête posé
   * par le précédent.
   *
   * `ignoreUserAgents` de la bibliothèque n'est volontairement pas repris :
   * aucune option du projet ne l'emploie, et une exemption fondée sur un
   * en-tête que le client choisit lui-même n'aurait de toute façon pas sa
   * place dans une protection anti-abus.
   */
  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const {
      context,
      limit,
      ttl,
      throttler,
      blockDuration,
      getTracker,
      generateKey,
    } = requestProps;
    const { req, res } = this.getRequestResponse(context);

    // `onModuleInit` de la bibliothèque a déjà remplacé tout nom absent par
    // « default » ; le type, lui, reste optionnel. Ce repli est donc mort en
    // pratique et n'existe que pour rester honnête vis-à-vis du contrat.
    const throttlerName = throttler.name ?? 'default';

    const tracker = await getTracker(req, context);
    const key = generateKey(context, tracker, throttlerName);
    const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } =
      await this.storageService.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );

    if (isBlocked) {
      await this.throwThrottlingException(context, {
        limit,
        ttl,
        key,
        tracker,
        totalHits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire,
      });
    }

    this.exposeQuota(
      res as Response,
      limit,
      Math.max(0, limit - totalHits),
      timeToExpire,
    );

    return true;
  }

  /**
   * Publie le budget restant, en ne gardant que le compteur le plus
   * contraignant.
   *
   * Une requête de connexion traverse quatre compteurs (minute et heure, par
   * IP et par email) : annoncer le dernier passé donnerait un reste faux,
   * plus généreux que la réalité, et un client qui s'y fie se ferait bloquer
   * sans prévenir. Les trois en-têtes sont réécrits **ensemble** pour qu'ils
   * décrivent toujours la même fenêtre.
   */
  private exposeQuota(
    response: Response,
    limit: number,
    remaining: number,
    resetSeconds: number,
  ): void {
    const alreadyPosted = response.getHeader(RATE_LIMIT_HEADERS.REMAINING);

    if (alreadyPosted !== undefined && Number(alreadyPosted) <= remaining) {
      return;
    }

    response.setHeader(RATE_LIMIT_HEADERS.LIMIT, String(limit));
    response.setHeader(RATE_LIMIT_HEADERS.REMAINING, String(remaining));
    response.setHeader(RATE_LIMIT_HEADERS.RESET, String(resetSeconds));
  }

  protected throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const retryAfter = Math.max(1, detail.timeToBlockExpire);
    const policy = this.policyService.policyFor(context);

    response.setHeader('Retry-After', String(retryAfter));

    this.rateLimitLogger.warn(
      `Limite de débit dépassée · ${request.method} ${request.originalUrl ?? request.url}` +
        ` · politique=${policy.id} · compteur=${maskTracker(detail.tracker)}` +
        ` · limite=${detail.limit} · attente=${retryAfter}s`,
    );

    const body: TooManyRequestsBody = {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      // Message unique pour toutes les routes : sur `login`, il est identique
      // que l'adresse visée corresponde à un compte ou non, et il ne dit pas
      // lequel des compteurs (IP ou email) a sauté. Aucune énumération.
      message: TOO_MANY_REQUESTS_MESSAGE,
      retryAfter,
    };

    throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}

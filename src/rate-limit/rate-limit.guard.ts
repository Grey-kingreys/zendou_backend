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
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { RateLimitPolicyService } from './rate-limit-policy.service';
import { TOO_MANY_REQUESTS_MESSAGE } from './rate-limit.constants';
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

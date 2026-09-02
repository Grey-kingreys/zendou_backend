import { createHash } from 'crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import type { Response } from 'express';
import { AUTH_USER_SELECT, resolveTestSenderAddress } from '../auth';
import { PrismaService } from '../prisma/prisma.service';
import { TOO_MANY_REQUESTS_MESSAGE } from '../rate-limit/rate-limit.constants';
import {
  maskTracker,
  resolveClientIp,
} from '../rate-limit/rate-limit.identity';
import { RedisThrottlerStorage } from '../rate-limit/redis-throttler.storage';
import { extractBearerToken, hashApiKey } from './api-key.utils';
import {
  API_KEY_FAILURE_KEY_PREFIX,
  API_KEY_FAILURE_WINDOW_MS,
  API_KEY_FAILURES_PER_MINUTE_DEFAULT,
  API_KEY_OWNER_SUSPENDED_MESSAGE,
  INVALID_API_KEY_MESSAGE,
} from './api-keys.constants';
import { ApiKeyAuthenticatedRequest } from './api-keys.types';

/**
 * Authentifie la requête à partir d'une clé API (`Authorization: Bearer zd_live_...`).
 * - 401 si le header est absent/mal formé ou si la clé est inconnue/révoquée
 * - 403 si le user propriétaire de la clé est suspendu
 * - 429 quand une même IP a dépassé son budget d'échecs (lot C, voir plus bas)
 * En cas de succès, `request.user` et `request.apiKeyId` sont renseignés.
 * `lastUsedAt` est mis à jour en tâche de fond, sans bloquer la requête.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyAuthGuard.name);
  private readonly failuresPerMinute: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    /**
     * Compteur partagé des échecs par IP.
     *
     * Optionnel **au sens de l'injection uniquement** : `ApiKeysModule`
     * l'apporte toujours en important `RateLimitCoreModule`. Le marquer
     * facultatif évite qu'un banc de test qui monte ce garde à la main pour
     * une tout autre raison (le filtre d'erreur global, par exemple) doive
     * déclarer un stockage Redis dont il n'a que faire. Absent, le garde se
     * comporte exactement comme avant le lot C : 401, sans comptage.
     */
    @Optional()
    private readonly throttlerStorage?: RedisThrottlerStorage,
  ) {
    this.failuresPerMinute =
      this.configService.get<number>(
        'RATE_LIMIT_API_KEY_FAILURES_PER_MINUTE',
      ) ?? API_KEY_FAILURES_PER_MINUTE_DEFAULT;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<ApiKeyAuthenticatedRequest>();

    const key = extractBearerToken(request.headers.authorization);

    if (!key) {
      throw await this.refusal(context, request);
    }

    const keyHash = hashApiKey(key);

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        revokedAt: true,
        user: { select: AUTH_USER_SELECT },
      },
    });

    if (!apiKey || apiKey.revokedAt) {
      throw await this.refusal(context, request);
    }

    if (apiKey.user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException(API_KEY_OWNER_SUSPENDED_MESSAGE);
    }

    // `testSenderAddress` n'est pas une colonne Prisma : voir la
    // documentation de `AuthUser.testSenderAddress` (`auth.types.ts`).
    // Aucune route authentifiée par clé API ne renvoie l'utilisateur complet
    // aujourd'hui, mais `request.user` est typé `AuthUser` : on complète ce
    // champ ici aussi, par cohérence, pour ne pas laisser un `AuthUser`
    // structurellement incomplet circuler dans la requête.
    request.user = {
      ...apiKey.user,
      testSenderAddress: resolveTestSenderAddress(this.configService),
    };
    request.apiKeyId = apiKey.id;

    // Fire-and-forget : ne doit jamais ralentir/bloquer la requête entrante.
    void this.prisma.apiKey
      .update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Échec de la mise à jour de lastUsedAt pour la clé ${apiKey.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    return true;
  }

  /**
   * Compte un échec sur l'IP et rend l'exception à lever : 429 si cette IP a
   * dépassé son budget, 401 sinon.
   *
   * **Seuls les échecs sont comptés** (header absent ou mal formé, clé
   * inconnue, clé révoquée) : une clé valide ne touche jamais ce compteur et
   * n'est jamais bloquée, même quand l'IP l'est. C'est la conséquence directe
   * du NAT opérateur guinéen - des milliers d'abonnés Orange/MTN partagent une
   * poignée d'IP publiques : bloquer l'IP entière punirait des clients
   * légitimes pour le bourrinage d'un seul. Ici, celui qui présente une clé
   * juste passe toujours ; seul celui qui en essaie au hasard est arrêté.
   *
   * L'IP est hachée avant d'entrer dans la clé Redis : aucune adresse en clair
   * ne stationne dans le magasin de compteurs.
   */
  private async refusal(
    context: ExecutionContext,
    request: ApiKeyAuthenticatedRequest,
  ): Promise<HttpException> {
    if (!this.throttlerStorage) {
      return new UnauthorizedException(INVALID_API_KEY_MESSAGE);
    }

    const ip = resolveClientIp(request);

    try {
      const record = await this.throttlerStorage.increment(
        `${API_KEY_FAILURE_KEY_PREFIX}${createHash('sha256').update(ip).digest('hex')}`,
        API_KEY_FAILURE_WINDOW_MS,
        this.failuresPerMinute,
        API_KEY_FAILURE_WINDOW_MS,
      );

      if (!record.isBlocked) {
        return new UnauthorizedException(INVALID_API_KEY_MESSAGE);
      }

      const retryAfter = Math.max(1, record.timeToBlockExpire);

      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader('Retry-After', String(retryAfter));

      this.logger.warn(
        `Trop d'échecs d'authentification par clé API · compteur=${maskTracker(`ip:${ip}`)}` +
          ` · limite=${this.failuresPerMinute}/min · attente=${retryAfter}s`,
      );

      return new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          // Même phrase que la limitation de débit globale : elle ne dit ni
          // quel compteur a sauté, ni si la clé présentée existait.
          message: TOO_MANY_REQUESTS_MESSAGE,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    } catch (error: unknown) {
      // Un compteur en panne ne doit jamais transformer un 401 en 500 : on
      // journalise et on rend le refus normal.
      this.logger.warn(
        "Compteur d'échecs de clé API indisponible : refus 401 sans comptage",
        error instanceof Error ? error.stack : String(error),
      );

      return new UnauthorizedException(INVALID_API_KEY_MESSAGE);
    }
  }
}

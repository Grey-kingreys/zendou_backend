import { createHash } from 'crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import type { Response } from 'express';
import {
  AUTH_USER_RECORD_SELECT,
  resolveTestSenderAddress,
  toAuthUser,
} from '../auth';
import type { AuthUserRecord } from '../auth';
import { PrismaService } from '../prisma/prisma.service';
import { TOO_MANY_REQUESTS_MESSAGE } from '../rate-limit/rate-limit.constants';
import {
  maskTracker,
  resolveClientIp,
} from '../rate-limit/rate-limit.identity';
import { RedisThrottlerStorage } from '../rate-limit/redis-throttler.storage';
import { extractBearerToken } from './api-key.utils';
import {
  API_KEY_FAILURE_KEY_PREFIX,
  API_KEY_FAILURE_WINDOW_MS,
  API_KEY_FAILURES_PER_MINUTE_DEFAULT,
  API_KEY_OWNER_SUSPENDED_MESSAGE,
  INVALID_API_KEY_MESSAGE,
} from './api-keys.constants';
import { ApiKeyAuthenticatedRequest } from './api-keys.types';
import { SecretHashingService } from './secret-hashing.service';

/** Ligne de clé API telle que chargée par le garde. */
interface AuthenticatedApiKey {
  id: string;
  revokedAt: Date | null;
  canRead: boolean;
  user: AuthUserRecord;
}

/**
 * Authentifie la requête à partir d'une clé API (`Authorization: Bearer zd_live_...`).
 * - 401 si le header est absent/mal formé ou si la clé est inconnue/révoquée
 * - 403 si le user propriétaire de la clé est suspendu
 * - 429 quand une même IP a dépassé son budget d'échecs (lot C, voir plus bas)
 * En cas de succès, `request.user`, `request.apiKeyId` et `request.apiKeyCanRead`
 * sont renseignés.
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
     * Dépendance **obligatoire**, et c'est le correctif d'un défaut mesuré en
     * production : marquée `@Optional()`, une erreur de visibilité de module ne
     * faisait pas échouer le démarrage, elle laissait ce champ à `undefined` -
     * et la limite d'échecs ne se déclenchait jamais, sans un mot dans les
     * journaux. Une protection anti-abus ne doit pas pouvoir être absente en
     * silence : mieux vaut un conteneur qui refuse de démarrer. C'est
     * `ApiKeysModule` qui la rend visible, en réexportant
     * `RateLimitCoreModule` (voir le commentaire de ce module).
     */
    private readonly throttlerStorage: RedisThrottlerStorage,
    /** Hachage des empreintes, poivre compris (E3). */
    private readonly secretHashing: SecretHashingService,
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

    // Deux empreintes possibles tant que la migration n'est pas terminée :
    // la forme poivrée (E3) d'abord, la forme historique ensuite.
    let apiKey: AuthenticatedApiKey | null = null;
    let storedHash: string | undefined;

    for (const candidate of this.secretHashing.candidateHashes(key)) {
      apiKey = await this.prisma.apiKey.findUnique({
        where: { keyHash: candidate },
        select: {
          id: true,
          revokedAt: true,
          canRead: true,
          user: { select: AUTH_USER_RECORD_SELECT },
        },
      });

      if (apiKey) {
        storedHash = candidate;
        break;
      }
    }

    if (!apiKey || apiKey.revokedAt) {
      throw await this.refusal(context, request);
    }

    // Migration paresseuse : la clé vient d'être reconnue sous son empreinte
    // historique, on la réécrit poivrée. Une clé révoquée n'arrive jamais ici
    // (elle est refusée juste au-dessus) : on ne ranime rien.
    if (
      storedHash !== undefined &&
      this.secretHashing.isLegacy(storedHash, key)
    ) {
      await this.migrateKeyHash(
        apiKey.id,
        this.secretHashing.hashForStorage(key),
      );
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
    request.user = toAuthUser(
      apiKey.user,
      resolveTestSenderAddress(this.configService),
    );
    request.apiKeyId = apiKey.id;
    request.apiKeyCanRead = apiKey.canRead;

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
   * Réécrit l'empreinte d'une clé reconnue sous sa forme historique.
   *
   * **Attendue**, à la différence de `lastUsedAt` : la requête suivante doit
   * trouver la clé sous sa forme poivrée, et une écriture non attendue laisse
   * la migration se faire indéfiniment. L'échec est toléré et journalisé - une
   * base en lecture seule ou une course perdue ne doit pas refuser une
   * authentification par ailleurs valide. Deux requêtes concurrentes écrivent
   * exactement la même valeur : il n'y a rien à sérialiser.
   */
  private async migrateKeyHash(id: string, keyHash: string): Promise<void> {
    try {
      await this.prisma.apiKey.update({ where: { id }, data: { keyHash } });
    } catch (error: unknown) {
      this.logger.warn(
        `Échec de la migration de l'empreinte de la clé ${id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
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

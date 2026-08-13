import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import { AUTH_USER_SELECT, resolveTestSenderAddress } from '../auth';
import { PrismaService } from '../prisma/prisma.service';
import { extractBearerToken, hashApiKey } from './api-key.utils';
import {
  API_KEY_OWNER_SUSPENDED_MESSAGE,
  INVALID_API_KEY_MESSAGE,
} from './api-keys.constants';
import { ApiKeyAuthenticatedRequest } from './api-keys.types';

/**
 * Authentifie la requête à partir d'une clé API (`Authorization: Bearer zd_live_...`).
 * - 401 si le header est absent/mal formé ou si la clé est inconnue/révoquée
 * - 403 si le user propriétaire de la clé est suspendu
 * En cas de succès, `request.user` et `request.apiKeyId` sont renseignés.
 * `lastUsedAt` est mis à jour en tâche de fond, sans bloquer la requête.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyAuthGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<ApiKeyAuthenticatedRequest>();

    const key = extractBearerToken(request.headers.authorization);

    if (!key) {
      throw new UnauthorizedException(INVALID_API_KEY_MESSAGE);
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
      throw new UnauthorizedException(INVALID_API_KEY_MESSAGE);
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
}

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiKeyAuthGuard } from '../api-keys';
import type { ApiKeyAuthenticatedRequest } from '../api-keys';
import { API_KEY_READ_FORBIDDEN_MESSAGE } from '../api-keys/api-keys.constants';
import { extractBearerToken } from '../api-keys/api-key.utils';
import { SessionAuthGuard } from '../auth';

/** Clé de métadonnée posée par {@link AllowApiKey} et {@link AllowApiKeyRead}. */
export const API_KEY_ACCESS = 'common:apiKeyAccess';

/** Niveau d'accès qu'une route ouvre aux clés API. */
type ApiKeyAccess = 'any' | 'read';

/**
 * Ouvre une route à **toute clé API active** (le solde), en plus de la
 * session. Sans marque, une route reste **session seulement** : c'est le
 * défaut, pour qu'une nouvelle route ne s'ouvre pas aux clés par oubli.
 */
export const AllowApiKey = (): MethodDecorator =>
  SetMetadata(API_KEY_ACCESS, 'any' satisfies ApiKeyAccess);

/**
 * Ouvre une route aux clés API **avec la permission de lecture**
 * (`ApiKey.canRead`), en plus de la session. Une clé sans lecture reçoit un
 * 403. La portée par domaine (B27) est appliquée par le service de la route.
 */
export const AllowApiKeyRead = (): MethodDecorator =>
  SetMetadata(API_KEY_ACCESS, 'read' satisfies ApiKeyAccess);

/**
 * Garde « session OU clé API ». Session par défaut ; sur une route marquée
 * {@link AllowApiKey} ou {@link AllowApiKeyRead}, un en-tête
 * `Authorization: Bearer ...` bascule vers `ApiKeyAuthGuard` (clé inconnue ou
 * révoquée : 401, propriétaire suspendu : 403, compteur d'échecs par IP
 * compris). Sans en-tête Bearer, c'est la session qui s'applique, comme avant.
 *
 * Deux niveaux : toute clé active suffit pour `AllowApiKey` ; `AllowApiKeyRead`
 * exige en plus `canRead`. Les clés ont une portée par domaine (B27), mais ce
 * garde ne la contrôle pas : chaque service de lecture l'applique à ses données.
 */
@Injectable()
export class SessionOrApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessionGuard: SessionAuthGuard,
    private readonly apiKeyGuard: ApiKeyAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.get<ApiKeyAccess | undefined>(
      API_KEY_ACCESS,
      context.getHandler(),
    );
    const request = context
      .switchToHttp()
      .getRequest<Request & ApiKeyAuthenticatedRequest>();

    if (access && extractBearerToken(request.headers.authorization)) {
      await this.apiKeyGuard.canActivate(context);

      if (access === 'read' && request.apiKeyCanRead !== true) {
        throw new ForbiddenException(API_KEY_READ_FORBIDDEN_MESSAGE);
      }

      return true;
    }

    return this.sessionGuard.canActivate(context);
  }
}

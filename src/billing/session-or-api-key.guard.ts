import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiKeyAuthGuard } from '../api-keys';
import { extractBearerToken } from '../api-keys/api-key.utils';
import { SessionAuthGuard } from '../auth';

/** Clé de métadonnée posée par {@link AllowApiKey}. */
const ALLOW_API_KEY = 'billing:allowApiKey';

/**
 * Autorise une route de facturation à accepter aussi une clé API. Sans cette
 * marque, une route reste **session seulement** : c'est le défaut, pour
 * qu'une nouvelle route ne s'ouvre pas aux clés par oubli.
 */
export const AllowApiKey = (): MethodDecorator =>
  SetMetadata(ALLOW_API_KEY, true);

/**
 * Garde de `BillingController`. Session par défaut ; sur une route marquée
 * {@link AllowApiKey}, un en-tête `Authorization: Bearer ...` bascule vers
 * `ApiKeyAuthGuard` (clé inconnue ou révoquée : 401, propriétaire suspendu :
 * 403, compteur d'échecs par IP compris). Sans en-tête Bearer, c'est la session
 * qui s'applique, comme avant.
 *
 * Les clés API n'ont pas de portée (scope) : toute clé active du compte suffit.
 */
@Injectable()
export class SessionOrApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessionGuard: SessionAuthGuard,
    private readonly apiKeyGuard: ApiKeyAuthGuard,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    const allowApiKey = this.reflector.get<boolean | undefined>(
      ALLOW_API_KEY,
      context.getHandler(),
    );
    const request = context.switchToHttp().getRequest<Request>();

    if (allowApiKey && extractBearerToken(request.headers.authorization)) {
      return this.apiKeyGuard.canActivate(context);
    }

    return this.sessionGuard.canActivate(context);
  }
}

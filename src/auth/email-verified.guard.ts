import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.types';
import { EMAIL_NOT_VERIFIED_MESSAGE } from './email-confirmation.constants';

/**
 * Ferme une route aux comptes dont l'adresse email n'est pas confirmée.
 *
 * À poser **après** un garde d'authentification (`SessionAuthGuard` ou
 * `ApiKeyAuthGuard`) : les deux renseignent `request.user` à partir de
 * `AUTH_USER_SELECT`, qui contient `emailVerifiedAt`. Aucune requête base
 * supplémentaire n'est donc nécessaire.
 *
 * Un compte non confirmé peut se connecter et consulter son espace — ce n'est
 * pas un compte gelé. Il ne peut que deux choses : envoyer un email, et créer
 * une clé API (c'est-à-dire obtenir le moyen d'envoyer). C'est exactement la
 * capacité qu'un spammeur viendrait chercher en créant des comptes en masse
 * sur notre compte SES, hors bac à sable.
 *
 * `emailVerifiedAt` absent (fixture de test, futur appelant qui construirait
 * un `AuthUser` partiel) vaut « non confirmé » : en cas de doute, on ferme.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user?.emailVerifiedAt) {
      throw new ForbiddenException(EMAIL_NOT_VERIFIED_MESSAGE);
    }

    return true;
  }
}

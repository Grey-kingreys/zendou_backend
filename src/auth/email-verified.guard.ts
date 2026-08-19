import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.types';
import { EMAIL_NOT_VERIFIED_MESSAGE } from './email-confirmation.constants';

/**
 * Prédicat de la règle « l'adresse de ce compte est confirmée ».
 *
 * Extrait du garde pour que le point d'acceptation des envois
 * (`EmailsService.accept`) applique **la même règle hors HTTP** : un garde ne
 * protège qu'une route, pas un appel direct au service — c'est précisément le
 * trou qu'ouvrirait un second point d'entrée comme le relais SMTP (B6/S1).
 *
 * Le paramètre est la colonne `User.emailVerifiedAt` elle-même : `null` tant
 * que l'adresse n'est pas confirmée, horodatée ensuite. C'est la seule source
 * de vérité. Un appelant qui, lui, lit un objet assemblé ailleurs (le garde
 * ci-dessous et son `request.user`) normalise l'absence en `null` avant
 * d'appeler : en cas de doute, on ferme.
 */
export function isEmailConfirmed(emailVerifiedAt: Date | null): boolean {
  return emailVerifiedAt !== null;
}

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

    // `?? null` : `request.user` est assemblé par le garde d'authentification
    // en amont et peut être partiel (fixture, appelant qui n'aurait pas utilisé
    // `AUTH_USER_SELECT`). Un champ absent n'est pas une confirmation.
    if (!isEmailConfirmed(request.user?.emailVerifiedAt ?? null)) {
      throw new ForbiddenException(EMAIL_NOT_VERIFIED_MESSAGE);
    }

    return true;
  }
}

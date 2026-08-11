import { Injectable, Logger } from '@nestjs/common';
import { SessionService } from '../auth/session.service';
import { TRACKER_KIND } from './rate-limit.constants';
import {
  ipIdentifier,
  readSessionToken,
  resolveApiKeyIdentifier,
  resolveResolvedUserIdentifier,
  resolveTargetEmail,
} from './rate-limit.identity';
import type { RateLimitRequest, TrackerKind } from './rate-limit.types';

/**
 * Choisit l'identifiant sur lequel une requête est comptée.
 *
 * Ce service tourne dans le garde **global**, donc avant `SessionAuthGuard`
 * et `ApiKeyAuthGuard` : `request.user` et `request.apiKeyId` ne sont pas
 * encore posés. L'identité est donc reconstruite ici, à partir du cookie de
 * session (une simple lecture Redis) ou du header `Authorization`. On
 * privilégie malgré tout les valeurs déjà posées si elles existent, pour
 * rester correct si l'ordre des gardes changeait un jour.
 */
@Injectable()
export class RateLimitTrackerService {
  private readonly logger = new Logger(RateLimitTrackerService.name);

  constructor(private readonly sessionService: SessionService) {}

  /**
   * Identifiant principal. Retombe toujours sur l'IP quand l'identité
   * demandée n'est pas disponible (requête anonyme sur une route protégée :
   * le garde d'authentification la rejettera juste après, mais elle doit
   * quand même être comptée).
   */
  async resolvePrimary(
    request: RateLimitRequest,
    kind: TrackerKind,
  ): Promise<string> {
    switch (kind) {
      case TRACKER_KIND.API_KEY:
        return resolveApiKeyIdentifier(request) ?? ipIdentifier(request);

      case TRACKER_KIND.USER:
        return (await this.resolveUser(request)) ?? ipIdentifier(request);

      case TRACKER_KIND.IDENTITY:
        return (
          resolveApiKeyIdentifier(request) ??
          (await this.resolveUser(request)) ??
          ipIdentifier(request)
        );

      case TRACKER_KIND.IP:
      case TRACKER_KIND.IP_AND_EMAIL:
      default:
        return ipIdentifier(request);
    }
  }

  /**
   * Identifiant secondaire, ou `undefined` quand la politique n'en prévoit
   * pas (ou que la requête ne porte pas d'email exploitable). Seules les
   * routes non authentifiées en ont un : l'IP seule ne suffit pas quand des
   * milliers d'abonnés partagent la même IP publique via le NAT opérateur,
   * et l'email seul ne suffit pas quand l'attaquant en change à chaque coup.
   */
  resolveSecondary(
    request: RateLimitRequest,
    kind: TrackerKind,
  ): string | undefined {
    return kind === TRACKER_KIND.IP_AND_EMAIL
      ? resolveTargetEmail(request)
      : undefined;
  }

  private async resolveUser(
    request: RateLimitRequest,
  ): Promise<string | undefined> {
    const alreadyResolved = resolveResolvedUserIdentifier(request);

    if (alreadyResolved) {
      return alreadyResolved;
    }

    const token = readSessionToken(request);

    if (!token) {
      return undefined;
    }

    try {
      const userId = await this.sessionService.peek(token);
      return userId ? `user:${userId}` : undefined;
    } catch (error) {
      // Redis indisponible : on ne fait pas échouer la requête pour autant,
      // le comptage retombera sur l'IP.
      this.logger.warn(
        "Résolution d'identité impossible pour la limitation de débit",
        error instanceof Error ? error.stack : String(error),
      );
      return undefined;
    }
  }
}

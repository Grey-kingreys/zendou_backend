import { createHmac } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hashApiKey } from './api-key.utils';

/**
 * Hachage des secrets porteurs (clés API et mots de passe SMTP) avec un
 * poivre secret (E3).
 *
 * Ce que le poivre change : l'empreinte stockée n'est plus calculable à partir
 * de la seule valeur du secret. Une fuite de la base - sauvegarde égarée,
 * injection SQL en lecture, accès d'un prestataire - ne suffit alors plus à
 * *vérifier* une clé devinée, puisqu'il faut aussi `API_KEY_PEPPER`, qui vit
 * dans l'environnement du processus et jamais dans PostgreSQL. Un secret de
 * 256 bits n'est de toute façon pas devinable ; le poivre protège contre
 * l'autre moitié du problème, celle où l'attaquant a déjà la base.
 *
 * Ce que le poivre ne change pas : le coût de vérification reste d'un HMAC,
 * donc aucune latence ajoutée sur le chemin d'authentification - ce n'est pas
 * un mot de passe humain, il n'y a rien à ralentir.
 *
 * **Sans `API_KEY_PEPPER`, le comportement est exactement l'historique**
 * (SHA-256 nu). La variable est optionnelle hors production, obligatoire en
 * production : voir `env.schema.ts`.
 */
@Injectable()
export class SecretHashingService {
  private readonly pepper: string | undefined;

  constructor(configService: ConfigService) {
    const configured = configService.get<string>('API_KEY_PEPPER');
    this.pepper =
      typeof configured === 'string' && configured.length > 0
        ? configured
        : undefined;
  }

  /** Forme persistée d'un secret : HMAC poivré si possible, SHA-256 sinon. */
  hashForStorage(secret: string): string {
    return this.pepper
      ? createHmac('sha256', this.pepper).update(secret).digest('hex')
      : hashApiKey(secret);
  }

  /**
   * Empreintes sous lesquelles un secret présenté peut être trouvé en base, de
   * la plus récente à la plus ancienne.
   *
   * Deux formes coexistent tant que toutes les lignes n'ont pas été migrées :
   * celles écrites avant l'arrivée du poivre portent l'empreinte SHA-256. On
   * cherche donc la forme poivrée d'abord (le cas courant à terme), puis
   * l'historique.
   */
  candidateHashes(secret: string): string[] {
    return this.pepper
      ? [this.hashForStorage(secret), hashApiKey(secret)]
      : [hashApiKey(secret)];
  }

  /**
   * L'empreinte stockée est-elle la forme historique d'un secret qu'on vient
   * de reconnaître, donc à réécrire ?
   *
   * Faux quand aucun poivre n'est configuré : il n'y a alors rien vers quoi
   * migrer, et réécrire une empreinte identique ne ferait qu'ajouter une
   * écriture à chaque appel authentifié.
   */
  isLegacy(hash: string, secret: string): boolean {
    return this.pepper !== undefined && hash === hashApiKey(secret);
  }
}

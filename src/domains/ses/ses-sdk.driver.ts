import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  AlreadyExistsException,
  BehaviorOnMxFailure,
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  DkimStatus,
  GetEmailIdentityCommand,
  type GetEmailIdentityCommandOutput,
  NotFoundException,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { DomainStatus } from '@prisma/client';
import { mailFromDomainOf } from '../domains.constants';
import type { IdentityState, SesIdentityDriver } from './ses-identity-driver';

export interface SesSdkDriverOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Implémentation réelle sur l'API Amazon SES v2.
 * Une identité de domaine créée ici a Easy DKIM activé : SES retourne
 * 3 tokens dont on dérive les CNAME à publier chez le registrar.
 */
export class SesSdkDriver implements SesIdentityDriver {
  private readonly logger = new Logger('SesIdentityDriver');
  private readonly client: SESv2Client;

  constructor(options: SesSdkDriverOptions) {
    this.client = new SESv2Client({
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async createIdentity(domain: string): Promise<{ dkimTokens: string[] }> {
    try {
      const response = await this.client.send(
        new CreateEmailIdentityCommand({ EmailIdentity: domain }),
      );

      await this.putMailFrom(domain);

      return { dkimTokens: response.DkimAttributes?.Tokens ?? [] };
    } catch (error) {
      if (error instanceof AlreadyExistsException) {
        // L'unicité du domaine côté Zendou est déjà garantie par la
        // contrainte `@unique` sur `Domain.name` (un autre client reçoit un
        // 409 avant d'arriver ici). L'identité SES est une ressource
        // partagée de notre compte AWS : elle peut préexister (domaine
        // vérifié hors Zendou, reprise après un échec d'écriture en base
        // alors que l'appel AWS avait réussi, ou rejeu de requête). La
        // retrouver plutôt que d'échouer est le comportement correct —
        // c'est un succès idempotent, pas une erreur.
        this.logger.warn(
          `Identité SES déjà existante pour ${domain}, jetons DKIM récupérés`,
        );
        return this.recoverExistingIdentity(domain);
      }
      throw error;
    }
  }

  /**
   * Récupère les jetons DKIM d'une identité SES déjà existante. Si SES ne
   * répond pas ou ne renvoie aucun jeton, on ne masque pas le problème : on
   * remonte une erreur claire plutôt qu'un 500 opaque.
   */
  private async recoverExistingIdentity(
    domain: string,
  ): Promise<{ dkimTokens: string[] }> {
    let response: GetEmailIdentityCommandOutput;
    try {
      response = await this.client.send(
        new GetEmailIdentityCommand({ EmailIdentity: domain }),
      );
    } catch (error) {
      this.logger.error(
        `Échec de récupération des jetons DKIM pour l'identité SES déjà existante ${domain}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException(
        "Le service d'envoi est momentanément indisponible, réessayez dans quelques minutes.",
      );
    }

    const dkimTokens = response.DkimAttributes?.Tokens ?? [];

    if (dkimTokens.length === 0) {
      this.logger.error(
        `Identité SES déjà existante ${domain} sans jeton DKIM disponible`,
      );
      throw new ServiceUnavailableException(
        "Le service d'envoi est momentanément indisponible, réessayez dans quelques minutes.",
      );
    }

    // Identité préexistante : le MAIL FROM n'est posé que s'il est absent.
    if (!response.MailFromAttributes?.MailFromDomain) {
      await this.putMailFrom(domain);
    }

    return { dkimTokens };
  }

  async getIdentityStatus(domain: string): Promise<IdentityState> {
    try {
      const response = await this.client.send(
        new GetEmailIdentityCommand({ EmailIdentity: domain }),
      );

      const mailFrom = response.MailFromAttributes;
      let mailFromStatus: IdentityState['mailFromStatus'] = null;

      if (mailFrom?.MailFromDomain) {
        mailFromStatus = mailFrom.MailFromDomainStatus ?? null;
      } else if (await this.putMailFrom(domain)) {
        // Posé à l'instant : SES attend encore de voir le MX.
        mailFromStatus = 'PENDING';
      }

      return {
        status: mapDkimStatus(response.DkimAttributes?.Status),
        mailFromStatus,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        // L'identité n'existe plus côté SES (supprimée hors de Zendou) :
        // la vérification ne pourra jamais aboutir en l'état.
        this.logger.warn(`Identité SES introuvable pour ${domain}`);
        return { status: DomainStatus.FAILED, mailFromStatus: null };
      }
      throw error;
    }
  }

  /**
   * Pose le MAIL FROM personnalisé `bounce.<domaine>`. `USE_DEFAULT_VALUE` :
   * tant que le client n'a pas publié le MX, SES expédie avec son MAIL FROM
   * par défaut et rien ne casse. Un échec est journalisé et n'empêche ni la
   * création du domaine ni son rafraîchissement : le prochain rafraîchissement
   * réessaiera. Rend `true` si l'attribut a été posé.
   */
  private async putMailFrom(domain: string): Promise<boolean> {
    try {
      await this.client.send(
        new PutEmailIdentityMailFromAttributesCommand({
          EmailIdentity: domain,
          MailFromDomain: mailFromDomainOf(domain),
          BehaviorOnMxFailure: BehaviorOnMxFailure.USE_DEFAULT_VALUE,
        }),
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `MAIL FROM personnalisé non posé pour ${domain} : ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async deleteIdentity(domain: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteEmailIdentityCommand({ EmailIdentity: domain }),
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        // Déjà supprimée : la suppression reste idempotente.
        this.logger.warn(`Identité SES déjà absente pour ${domain}`);
        return;
      }
      throw error;
    }
  }
}

/** Traduit le statut DKIM SES en statut de domaine Zendou. */
export function mapDkimStatus(status: DkimStatus | undefined): DomainStatus {
  switch (status) {
    case DkimStatus.SUCCESS:
      return DomainStatus.VERIFIED;
    case DkimStatus.FAILED:
      return DomainStatus.FAILED;
    case DkimStatus.TEMPORARY_FAILURE:
      return DomainStatus.TEMPORARY_FAILURE;
    case DkimStatus.PENDING:
    case DkimStatus.NOT_STARTED:
    default:
      return DomainStatus.PENDING;
  }
}

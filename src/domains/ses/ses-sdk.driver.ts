import { Logger } from '@nestjs/common';
import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  DkimStatus,
  GetEmailIdentityCommand,
  NotFoundException,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { DomainStatus } from '@prisma/client';
import type { SesIdentityDriver } from './ses-identity-driver';

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
    const response = await this.client.send(
      new CreateEmailIdentityCommand({ EmailIdentity: domain }),
    );

    return { dkimTokens: response.DkimAttributes?.Tokens ?? [] };
  }

  async getIdentityStatus(domain: string): Promise<DomainStatus> {
    try {
      const response = await this.client.send(
        new GetEmailIdentityCommand({ EmailIdentity: domain }),
      );

      return mapDkimStatus(response.DkimAttributes?.Status);
    } catch (error) {
      if (error instanceof NotFoundException) {
        // L'identité n'existe plus côté SES (supprimée hors de Zendou) :
        // la vérification ne pourra jamais aboutir en l'état.
        this.logger.warn(`Identité SES introuvable pour ${domain}`);
        return DomainStatus.FAILED;
      }
      throw error;
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

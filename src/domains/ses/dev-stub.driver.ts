import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DomainStatus } from '@prisma/client';
import type { SesIdentityDriver } from './ses-identity-driver';

/** Nombre de tokens DKIM générés par SES pour une identité de domaine. */
const DKIM_TOKEN_COUNT = 3;

/** Longueur d'un token DKIM SES (32 caractères). */
const DKIM_TOKEN_LENGTH = 32;

/**
 * Driver de développement : aucun appel réseau, aucune clé AWS requise.
 * Les tokens DKIM sont dérivés du nom de domaine (déterministes d'un
 * redémarrage à l'autre) et le statut reste `PENDING`.
 */
export class DevStubDriver implements SesIdentityDriver {
  private readonly logger = new Logger('SesIdentityDriver');

  createIdentity(domain: string): Promise<{ dkimTokens: string[] }> {
    const dkimTokens = stubDkimTokens(domain);
    this.logger.log(
      `[SES stub] createIdentity(${domain}) → ${dkimTokens.length} tokens DKIM simulés`,
    );
    return Promise.resolve({ dkimTokens });
  }

  getIdentityStatus(domain: string): Promise<DomainStatus> {
    this.logger.log(
      `[SES stub] getIdentityStatus(${domain}) → ${DomainStatus.PENDING}`,
    );
    return Promise.resolve(DomainStatus.PENDING);
  }

  deleteIdentity(domain: string): Promise<void> {
    this.logger.log(`[SES stub] deleteIdentity(${domain}) → sans effet`);
    return Promise.resolve();
  }
}

/** Dérive 3 pseudo-tokens DKIM stables à partir du nom de domaine. */
export function stubDkimTokens(domain: string): string[] {
  return Array.from({ length: DKIM_TOKEN_COUNT }, (_unused, index) =>
    createHash('sha256')
      .update(`zendou-dkim-stub:${domain}:${index}`)
      .digest('hex')
      .slice(0, DKIM_TOKEN_LENGTH),
  );
}

import type { DomainStatus } from '@prisma/client';

/** Token d'injection du driver d'identités SES. */
export const SES_IDENTITY_DRIVER = 'SES_IDENTITY_DRIVER';

/**
 * Abstraction des opérations SES sur une identité de domaine.
 * Deux implémentations : `SesSdkDriver` (SESv2 réel) et `DevStubDriver`
 * (développement local, sans clés AWS).
 */
export interface SesIdentityDriver {
  /** Crée l'identité de domaine et retourne les 3 tokens DKIM à publier. */
  createIdentity(domain: string): Promise<{ dkimTokens: string[] }>;

  /** Interroge l'état de vérification DKIM de l'identité. */
  getIdentityStatus(domain: string): Promise<DomainStatus>;

  /** Supprime l'identité. Idempotent : ne lève pas si elle n'existe plus. */
  deleteIdentity(domain: string): Promise<void>;
}

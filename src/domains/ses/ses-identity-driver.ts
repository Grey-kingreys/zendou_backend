import type { DomainStatus } from '@prisma/client';

/** Token d'injection du driver d'identités SES. */
export const SES_IDENTITY_DRIVER = 'SES_IDENTITY_DRIVER';

/** `MailFromDomainStatus` de SES. */
export type MailFromStatus =
  'PENDING' | 'SUCCESS' | 'FAILED' | 'TEMPORARY_FAILURE';

/** État d'une identité : vérification DKIM et MAIL FROM personnalisé. */
export interface IdentityState {
  status: DomainStatus;
  /** `null` quand le MAIL FROM n'a pas pu être lu ni posé. */
  mailFromStatus: MailFromStatus | null;
}

/**
 * Abstraction des opérations SES sur une identité de domaine.
 * Deux implémentations : `SesSdkDriver` (SESv2 réel) et `DevStubDriver`
 * (développement local, sans clés AWS).
 */
export interface SesIdentityDriver {
  /**
   * Crée l'identité de domaine et retourne les 3 tokens DKIM à publier. Pose
   * aussi le MAIL FROM personnalisé `bounce.<domaine>` (repli sur la valeur
   * par défaut de SES si le MX manque : rien ne casse sans lui).
   */
  createIdentity(domain: string): Promise<{ dkimTokens: string[] }>;

  /**
   * Interroge l'état de vérification DKIM et du MAIL FROM de l'identité. Pose
   * le MAIL FROM s'il est absent (identités créées avant son introduction) ;
   * jamais s'il est déjà posé.
   */
  getIdentityStatus(domain: string): Promise<IdentityState>;

  /** Supprime l'identité. Idempotent : ne lève pas si elle n'existe plus. */
  deleteIdentity(domain: string): Promise<void>;
}

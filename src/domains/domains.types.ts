import type { DomainStatus } from '@prisma/client';
import type { DnsRecord, RecommendedDnsRecord } from './dns-records';
import type { MailFromStatus } from './ses/ses-identity-driver';

/** Domaine tel qu'il apparaît dans la liste. */
export interface DomainSummary {
  id: string;
  name: string;
  status: DomainStatus;
  verifiedAt: Date | null;
  createdAt: Date;
}

/** Domaine avec tout ce qu'il faut publier dans la zone DNS. */
export interface DomainDetail extends DomainSummary {
  /** Domaine MAIL FROM personnalisé : `bounce.<domaine>`. */
  mailFromDomain: string;
  /** Dernier statut MAIL FROM connu de SES, `null` avant le premier rafraîchissement. */
  mailFromStatus: MailFromStatus | null;
  dkimRecords: DnsRecord[];
  recommendedRecords: RecommendedDnsRecord[];
}

/** Clé API liée à un domaine (B27), telle qu'exposée avant sa suppression. */
export interface DomainUsageApiKey {
  id: string;
  name: string;
  prefix: string;
  /** `true` si ce domaine est son DERNIER : la suppression la révoque. */
  willBeRevoked: boolean;
}

/** Identifiant SMTP lié à un domaine (B27). */
export interface DomainUsageSmtpCredential {
  id: string;
  name: string;
  username: string;
  prefix: string;
  /** `true` si ce domaine est son DERNIER : la suppression le révoque. */
  willBeRevoked: boolean;
}

/**
 * Aperçu d'impact d'une suppression de domaine (B27) : les clés API et
 * identifiants SMTP ACTIFS dont la portée inclut ce domaine.
 */
export interface DomainUsage {
  apiKeys: DomainUsageApiKey[];
  smtpCredentials: DomainUsageSmtpCredential[];
}

/** Réponse à la suppression d'un domaine : ce qui a été révoqué (B27). */
export interface DomainRemoveResult {
  revokedApiKeys: { id: string; name: string; prefix: string }[];
  revokedSmtpCredentials: {
    id: string;
    name: string;
    username: string;
    prefix: string;
  }[];
}

/** Résultat d'une interrogation du statut de vérification. */
export interface DomainCheckResult {
  id: string;
  status: DomainStatus;
  verifiedAt: Date | null;
  mailFromStatus: MailFromStatus | null;
}

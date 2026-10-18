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

/** Résultat d'une interrogation du statut de vérification. */
export interface DomainCheckResult {
  id: string;
  status: DomainStatus;
  verifiedAt: Date | null;
  mailFromStatus: MailFromStatus | null;
}

import type { DomainStatus } from '@prisma/client';
import type { DnsRecord, RecommendedDnsRecord } from './dns-records';

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
  dkimRecords: DnsRecord[];
  recommendedRecords: RecommendedDnsRecord[];
}

/** Résultat d'une interrogation du statut de vérification. */
export interface DomainCheckResult {
  id: string;
  status: DomainStatus;
  verifiedAt: Date | null;
}

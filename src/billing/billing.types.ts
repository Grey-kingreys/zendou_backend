import type { TopUpMethod, TopUpStatus } from '@prisma/client';

/** Agrégats de solde exposés au client. */
export interface BalanceSummary {
  balance: number;
  totalPurchased: number;
  totalConsumed: number;
}

/** Ligne du ledger de crédits telle qu'exposée par la liste paginée. */
export interface CreditEntryItem {
  delta: number;
  reason: string;
  reference: string | null;
  createdAt: Date;
}

export interface PaginatedCreditEntries {
  items: CreditEntryItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Query brute reçue par le contrôleur (tous les champs arrivent en string
 * depuis Express). Le parsing/validation est fait explicitement dans
 * `BillingService`, à l'image d'`EmailsLogService`.
 */
export interface RawEntriesListQuery {
  page?: string;
  limit?: string;
}

/** Demande de recharge telle qu'exposée au client qui l'a créée. */
export interface TopUpRequestItem {
  id: string;
  packId: string;
  credits: number;
  amountGnf: number;
  method: TopUpMethod;
  phoneNumber: string;
  transactionRef: string;
  status: TopUpStatus;
  rejectionReason: string | null;
  createdAt: Date;
}

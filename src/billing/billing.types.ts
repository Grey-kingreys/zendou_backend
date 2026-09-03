import type { TopUpMethod, TopUpStatus } from '@prisma/client';

/**
 * Agrégats de solde exposés au client.
 *
 * Liste d'autorisation, pas liste d'exclusion : `totalPurchased` est défini
 * de façon fermée (motif `TOPUP` uniquement — le seul adossé à un
 * encaissement réel) ; `totalGifted` est défini de façon ouverte (tout le
 * reste : crédit de bienvenue, avoir admin, et tout futur motif de crédit
 * gratuit, comptés à part sans jamais gonfler `totalPurchased`).
 * Identité : `balance === totalPurchased + totalGifted - totalConsumed`.
 */
export interface BalanceSummary {
  balance: number;
  totalPurchased: number;
  totalGifted: number;
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

/**
 * Méthode de paiement configurée, exposée par
 * `GET /v1/billing/payment-methods`. N'apparaît dans la liste que si son
 * numéro Zendou est configuré côté serveur (`PAYMENT_METHOD_ENV_KEYS`,
 * `billing.constants.ts`) - aucune méthode « non disponible » n'y figure.
 */
export interface PaymentMethodItem {
  method: TopUpMethod;
  label: string;
  number: string;
  accountName: string | null;
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

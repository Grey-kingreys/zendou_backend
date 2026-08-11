import type { UserStatus } from '@prisma/client';

/**
 * - `OK` : rien à signaler.
 * - `WARNING` : les taux approchent un seuil de suspension (alerte).
 * - `SUSPEND` : un seuil est dépassé, le compte a été suspendu.
 */
export type ReputationVerdict = 'OK' | 'WARNING' | 'SUSPEND';

/** Photographie des taux d'un client sur la fenêtre d'observation. */
export interface ReputationMetrics {
  /** Envois réellement partis (SENT + DELIVERED + BOUNCED + COMPLAINED). */
  sent: number;
  bounces: number;
  complaints: number;
  /** `bounces / sent`, ou 0 si aucun envoi. */
  bounceRate: number;
  /** `complaints / sent`, ou 0 si aucun envoi. */
  complaintRate: number;
  verdict: ReputationVerdict;
}

/** Réponse de `GET /v1/reputation` : métriques + état du compte. */
export interface ReputationOverview extends ReputationMetrics {
  dailySendLimit: number;
  status: UserStatus;
}

/** Colonnes du client nécessaires à l'évaluation et aux paliers. */
export interface ReputationUser {
  id: string;
  email: string;
  status: UserStatus;
  dailySendLimit: number;
  createdAt: Date;
}

import type { TopUpMethod, TopUpStatus } from '@prisma/client';

/** Demande de recharge telle qu'exposée à l'admin, avec l'identité du client. */
export interface AdminTopUpRequestItem {
  id: string;
  user: { id: string; email: string; name: string };
  packId: string;
  credits: number;
  amountGnf: number;
  method: TopUpMethod;
  phoneNumber: string;
  transactionRef: string;
  status: TopUpStatus;
  createdAt: Date;
}

export interface RawAdminTopUpRequestsQuery {
  status?: string;
}

export interface AdminTopUpRequestReviewResult {
  id: string;
  status: TopUpStatus;
}

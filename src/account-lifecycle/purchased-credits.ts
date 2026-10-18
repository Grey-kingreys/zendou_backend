import type { Prisma } from '@prisma/client';
import { CREDIT_REASON_TOPUP } from '../billing/billing.constants';

/** Ce dont la protection a besoin : le grand livre, hors ou dans une transaction. */
type LedgerReader = Pick<Prisma.TransactionClient, 'creditEntry'>;

/**
 * Un compte qui a encore des crédits **achetés** : au moins une recharge
 * (`TOPUP`) et un solde courant strictement positif. Les crédits sont
 * fongibles, donc tout solde positif d'un compte qui a acheté compte comme
 * acheté. Ni le bonus de bienvenue, ni un geste d'admin, ni un historique
 * d'envois ne protègent à eux seuls ; un compte dont le solde est retombé à 0
 * n'est plus protégé.
 *
 * Un tel compte n'est jamais anonymisé automatiquement pour inactivité (ANON-1,
 * décision du porteur). Calculé par compte à chaque évaluation, jamais mémorisé.
 */
export async function hasPurchasedCredits(
  db: LedgerReader,
  userId: string,
): Promise<boolean> {
  const topUps = await db.creditEntry.count({
    where: { userId, reason: CREDIT_REASON_TOPUP },
  });

  if (topUps === 0) {
    return false;
  }

  const { _sum } = await db.creditEntry.aggregate({
    where: { userId },
    _sum: { delta: true },
  });

  return (_sum.delta ?? 0) > 0;
}

/**
 * Packs de crédits — catalogue en dur (cahier des charges §7.2).
 * Volontairement pas en base : le catalogue est un artefact de code, pas
 * une donnée métier modifiable en production tant qu'il n'y a qu'une
 * poignée d'offres. Les prix sont indicatifs, non définitifs.
 */
export interface CreditPack {
  id: string;
  label: string;
  credits: number;
  amountGnf: number;
  /** Un pack non achetable est seulement informatif (ex. offre découverte). */
  purchasable: boolean;
}

export const CREDIT_PACKS: readonly CreditPack[] = [
  {
    id: 'decouverte',
    label: 'Découverte',
    credits: 1_000,
    amountGnf: 0,
    purchasable: false,
  },
  {
    id: 'starter',
    label: 'Starter',
    credits: 10_000,
    amountGnf: 25_000,
    purchasable: true,
  },
  {
    id: 'growth',
    label: 'Growth',
    credits: 30_000,
    amountGnf: 60_000,
    purchasable: true,
  },
  {
    id: 'pack5000',
    label: 'Pack 5 000 — sans expiration',
    credits: 5_000,
    amountGnf: 15_000,
    purchasable: true,
  },
];

/** Retrouve un pack par son identifiant, ou `undefined` s'il n'existe pas. */
export function findPack(packId: string): CreditPack | undefined {
  return CREDIT_PACKS.find((pack) => pack.id === packId);
}

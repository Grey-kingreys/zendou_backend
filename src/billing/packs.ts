/**
 * Packs de crédits — catalogue en dur (cahier des charges §7.2).
 * Volontairement pas en base : le catalogue est un artefact de code, pas
 * une donnée métier modifiable en production tant qu'il n'y a qu'une
 * poignée d'offres. Grille tarifaire figée par le porteur le 13/08/2026
 * (tranche le point ouvert §12.2 — ce n'est plus la proposition indicative
 * du §7.2) ; elle reste modifiable ici en code si le porteur revoit les
 * tarifs plus tard, mais ce n'est plus un brouillon à valider.
 *
 * Le prix unitaire doit décroître avec le volume (cf. packs.spec.ts) :
 * un petit pack plus cher au crédit que le plus gros pack n'a pas de sens
 * commercial.
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
    id: 'essentiel',
    label: 'Essentiel',
    credits: 15_000,
    amountGnf: 50_000,
    purchasable: true,
  },
  {
    id: 'growth',
    label: 'Growth',
    credits: 30_000,
    amountGnf: 90_000,
    purchasable: true,
  },
];

/** Retrouve un pack par son identifiant, ou `undefined` s'il n'existe pas. */
export function findPack(packId: string): CreditPack | undefined {
  return CREDIT_PACKS.find((pack) => pack.id === packId);
}

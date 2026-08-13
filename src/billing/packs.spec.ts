import { CREDIT_PACKS, findPack } from './packs';

describe('CREDIT_PACKS', () => {
  it('marks decouverte as informative only (not purchasable)', () => {
    const decouverte = findPack('decouverte');

    expect(decouverte).toMatchObject({
      credits: 1_000,
      amountGnf: 0,
      purchasable: false,
    });
  });

  it.each([
    ['essentiel', 15_000, 50_000],
    ['growth', 30_000, 90_000],
  ])(
    'exposes %s as purchasable with the right credits/price',
    (id, credits, amountGnf) => {
      const pack = findPack(id);

      expect(pack).toMatchObject({ credits, amountGnf, purchasable: true });
    },
  );

  it('returns undefined for an unknown pack id', () => {
    expect(findPack('does-not-exist')).toBeUndefined();
  });

  it('gives every pack a distinct id', () => {
    const ids = CREDIT_PACKS.map((pack) => pack.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never mentions a duration or an expiration in a label (crédits cumulatifs, rien n'expire)", () => {
    const suspicious = /expir|durée|valable|jour|mois|an(s)?\b/i;

    for (const pack of CREDIT_PACKS) {
      expect(pack.label).not.toMatch(suspicious);
    }
  });

  it('has a strictly decreasing unit price (GNF/crédit) as volume grows across purchasable packs', () => {
    const purchasable = CREDIT_PACKS.filter((pack) => pack.purchasable).sort(
      (a, b) => a.credits - b.credits,
    );

    const unitPrices = purchasable.map((pack) => pack.amountGnf / pack.credits);

    for (let i = 1; i < unitPrices.length; i += 1) {
      expect(unitPrices[i]).toBeLessThan(unitPrices[i - 1]);
    }
  });
});

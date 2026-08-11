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
    ['starter', 10_000, 25_000],
    ['growth', 30_000, 60_000],
    ['pack5000', 5_000, 15_000],
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
});

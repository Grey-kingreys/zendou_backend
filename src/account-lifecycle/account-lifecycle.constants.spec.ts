import { addMonthsUtc, maskPhoneNumber } from './account-lifecycle.constants';

describe('maskPhoneNumber', () => {
  it.each([
    ['+224621112233', '+224****2233'],
    ['+224 621 11 22 33', '+224****2233'],
    ['621112233', '****2233'],
    ['1234', '****'],
    ['+22412', '****2412'],
  ])('%s devient %s', (input, expected) => {
    expect(maskPhoneNumber(input)).toBe(expected);
  });
});

describe('addMonthsUtc', () => {
  it('borne le jour au dernier jour du mois cible', () => {
    expect(
      addMonthsUtc(new Date('2026-03-31T00:00:00.000Z'), -1).toISOString(),
    ).toBe('2026-02-28T00:00:00.000Z');
  });

  it('recule de 24 mois', () => {
    expect(
      addMonthsUtc(new Date('2028-01-01T00:00:00.000Z'), -24).toISOString(),
    ).toBe('2026-01-01T00:00:00.000Z');
  });
});

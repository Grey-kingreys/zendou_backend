import {
  formatEmailAddress,
  normalizeEmailAddress,
  parseEmailAddress,
} from './email-address';

describe('parseEmailAddress', () => {
  it('accepts a bare address and lowercases it', () => {
    expect(parseEmailAddress('Contact@Boutique-Awa.GN')).toEqual({
      address: 'contact@boutique-awa.gn',
      domain: 'boutique-awa.gn',
    });
  });

  it('accepts the « Nom <adresse> » form and keeps the display name', () => {
    expect(parseEmailAddress('Awa Diallo <contact@boutique-awa.gn>')).toEqual({
      name: 'Awa Diallo',
      address: 'contact@boutique-awa.gn',
      domain: 'boutique-awa.gn',
    });
  });

  it('unquotes a quoted display name', () => {
    expect(
      parseEmailAddress('"Diallo, Awa" <contact@boutique-awa.gn>'),
    ).toEqual({
      name: 'Diallo, Awa',
      address: 'contact@boutique-awa.gn',
      domain: 'boutique-awa.gn',
    });
  });

  it('treats an empty display name as a bare address', () => {
    expect(parseEmailAddress('  <contact@boutique-awa.gn>  ')).toEqual({
      address: 'contact@boutique-awa.gn',
      domain: 'boutique-awa.gn',
    });
  });

  it('reads sub-domains and multi-label domains', () => {
    expect(parseEmailAddress('no-reply@mail.boutique-awa.gn')?.domain).toBe(
      'mail.boutique-awa.gn',
    );
  });

  it.each([
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['no @ at all', 'pas-un-email'],
    ['no domain', 'contact@'],
    ['no local part', '@boutique-awa.gn'],
    ['a domain without a dot', 'contact@localhost'],
    ['a doubled @', 'contact@@boutique-awa.gn'],
    ['an IP literal domain', 'contact@127.0.0.1'],
    ['an invalid address inside brackets', 'Awa <pas-un-email>'],
    ['empty brackets', 'Awa <>'],
    ['trailing text after the brackets', 'Awa <a@boutique-awa.gn> et co'],
    ['a leading dot in the local part', '.contact@boutique-awa.gn'],
    ['a doubled dot in the local part', 'con..tact@boutique-awa.gn'],
    ['a space inside the address', 'con tact@boutique-awa.gn'],
    ['a protocol', 'http://boutique-awa.gn'],
  ])('rejects %s', (_label, input) => {
    expect(parseEmailAddress(input)).toBeNull();
  });

  it('rejects addresses beyond the RFC length limits', () => {
    expect(parseEmailAddress(`${'a'.repeat(65)}@boutique-awa.gn`)).toBeNull();
    expect(parseEmailAddress(`contact@${'a'.repeat(250)}.gn`)).toBeNull();
  });
});

describe('normalizeEmailAddress', () => {
  it('normalizes a valid bare address', () => {
    expect(normalizeEmailAddress('  Client@Exemple.GN ')).toBe(
      'client@exemple.gn',
    );
  });

  it('refuses the « Nom <adresse> » form — recipients are bare addresses', () => {
    expect(normalizeEmailAddress('Awa <client@exemple.gn>')).toBeNull();
  });
});

describe('formatEmailAddress', () => {
  it('returns the bare address when there is no display name', () => {
    expect(
      formatEmailAddress({
        address: 'contact@boutique-awa.gn',
        domain: 'boutique-awa.gn',
      }),
    ).toBe('contact@boutique-awa.gn');
  });

  it('rebuilds the « Nom <adresse> » form', () => {
    expect(
      formatEmailAddress({
        name: 'Awa Diallo',
        address: 'contact@boutique-awa.gn',
        domain: 'boutique-awa.gn',
      }),
    ).toBe('Awa Diallo <contact@boutique-awa.gn>');
  });

  it('quotes a display name holding special characters', () => {
    expect(
      formatEmailAddress({
        name: 'Diallo, Awa',
        address: 'contact@boutique-awa.gn',
        domain: 'boutique-awa.gn',
      }),
    ).toBe('"Diallo, Awa" <contact@boutique-awa.gn>');
  });

  it('round-trips a quoted display name', () => {
    const parsed = parseEmailAddress('"Diallo, Awa" <contact@boutique-awa.gn>');

    expect(parsed).not.toBeNull();
    expect(formatEmailAddress(parsed!)).toBe(
      '"Diallo, Awa" <contact@boutique-awa.gn>',
    );
  });
});

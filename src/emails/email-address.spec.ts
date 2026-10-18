import {
  formatEmailAddress,
  normalizeEmailAddress,
  parseEmailAddress,
  toSesAddress,
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

describe('toSesAddress', () => {
  /** Décode un mot encodé `=?UTF-8?B?...?=` (le contrôle inverse de l'encodage). */
  function decodeWords(encoded: string): string {
    return encoded
      .split(' ')
      .map((word) => {
        const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word);
        expect(match).not.toBeNull();
        return Buffer.from(match![1], 'base64').toString('utf8');
      })
      .join('');
  }

  it('laisse inchangés une adresse nue et un nom ASCII, avec ou sans guillemets', () => {
    expect(toSesAddress('contact@boutique-awa.gn')).toBe(
      'contact@boutique-awa.gn',
    );
    expect(toSesAddress('Awa Diallo <contact@boutique-awa.gn>')).toBe(
      'Awa Diallo <contact@boutique-awa.gn>',
    );
    expect(toSesAddress('"Diallo, Awa" <contact@boutique-awa.gn>')).toBe(
      '"Diallo, Awa" <contact@boutique-awa.gn>',
    );
  });

  it('encode un nom accentué en mot encodé RFC 2047', () => {
    expect(toSesAddress('Aïssatou <a@b.gn>')).toBe(
      `=?UTF-8?B?${Buffer.from('Aïssatou').toString('base64')}?= <a@b.gn>`,
    );
  });

  it('encode aussi un nom accentué qui contient une virgule ou des guillemets', () => {
    const result = toSesAddress('"Diallo, Aïcha" <a@b.gn>');

    expect(result).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <a@b\.gn>$/);
    expect(result).not.toContain('"');
    expect(decodeWords(result.replace(' <a@b.gn>', ''))).toBe('Diallo, Aïcha');
  });

  it('découpe un nom très long en mots de 75 caractères au plus, sans couper un caractère', () => {
    const name = `${'é'.repeat(80)} Diallo`;
    const result = toSesAddress(`${name} <a@b.gn>`);
    const words = result.replace(' <a@b.gn>', '').split(' ');

    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeWords(words.join(' '))).toBe(name);
  });
});

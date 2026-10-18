import {
  MAX_CUSTOM_HEADERS,
  MAX_HEADER_VALUE_LENGTH,
  validateCustomHeaders,
} from './email-headers';

describe('validateCustomHeaders', () => {
  it('accepte List-Unsubscribe, List-Unsubscribe-Post et X-*, sans tenir compte de la casse', () => {
    expect(
      validateCustomHeaders({
        'List-Unsubscribe':
          '<https://exemple.gn/stop?u=1>, <mailto:stop@exemple.gn>',
        'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
        'X-Entity-Ref-ID': 'abc123',
        'x-campagne': 'rentree',
      }),
    ).toBeNull();
  });

  it.each([
    'From',
    'To',
    'Subject',
    'Reply-To',
    'Return-Path',
    'DKIM-Signature',
    'Content-Type',
    'content-transfer-encoding',
    'MIME-Version',
    'Message-ID',
    'Cc',
    'Bcc',
    'Date',
  ])('refuse l’en-tête réservé %s', (name) => {
    const message = validateCustomHeaders({ [name]: 'valeur' });

    expect(message).toContain(`« ${name} »`);
    expect(message).toContain("n'est pas autorisé");
  });

  it.each(['X-SES-CONFIGURATION-SET', 'x-ses-source-arn'])(
    'refuse %s, préfixe réservé à SES',
    (name) => {
      expect(validateCustomHeaders({ [name]: 'valeur' })).toContain(
        "n'est pas autorisé",
      );
    },
  );

  it.each(['Mauvais Nom', 'X-Nom:', 'X-Nom\n', 'X-Énorme', ''])(
    'refuse le nom non conforme RFC 5322 %j',
    (name) => {
      expect(validateCustomHeaders({ [name]: 'v' })).toContain('invalide');
    },
  );

  it.each(['a\nBcc: pirate@exemple.gn', 'a\rb', 'a\r\nb'])(
    'refuse une valeur avec saut de ligne (%j)',
    (value) => {
      expect(validateCustomHeaders({ 'X-Test': value })).toContain(
        'sans saut de ligne',
      );
    },
  );

  it('refuse une valeur vide, non textuelle ou trop longue', () => {
    expect(validateCustomHeaders({ 'X-Test': '' })).not.toBeNull();
    expect(validateCustomHeaders({ 'X-Test': 12 })).not.toBeNull();
    expect(
      validateCustomHeaders({
        'X-Test': 'a'.repeat(MAX_HEADER_VALUE_LENGTH + 1),
      }),
    ).not.toBeNull();
    expect(
      validateCustomHeaders({ 'X-Test': 'a'.repeat(MAX_HEADER_VALUE_LENGTH) }),
    ).toBeNull();
  });

  it('accepte 20 en-têtes et refuse le 21e', () => {
    const make = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`X-N${i}`, 'v']),
      );

    expect(validateCustomHeaders(make(MAX_CUSTOM_HEADERS))).toBeNull();
    expect(validateCustomHeaders(make(MAX_CUSTOM_HEADERS + 1))).toContain(
      '20 en-têtes',
    );
  });

  it('refuse deux noms qui ne diffèrent que par la casse', () => {
    expect(validateCustomHeaders({ 'X-Test': 'a', 'x-test': 'b' })).toContain(
      'plusieurs fois',
    );
  });

  it.each([null, 'texte', ['X-A'], 5])(
    'refuse un champ qui n’est pas un objet (%j)',
    (value) => {
      expect(validateCustomHeaders(value)).toContain('doit être un objet');
    },
  );
});

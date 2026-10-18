import {
  MAX_CUSTOM_HEADERS,
  MAX_HEADER_NAME_LENGTH,
  MAX_HEADER_TOTAL_LENGTH,
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
        'ASCII imprimable',
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
    ).toContain('de 995 caractères');
    // Nom de 3 caractères : 996 - 3 = 993 caractères de valeur au plus.
    expect(
      validateCustomHeaders({ 'X-A': 'a'.repeat(MAX_HEADER_TOTAL_LENGTH - 3) }),
    ).toBeNull();
  });

  it.each(['é', 'a\u0000b', 'a\tb', 'a\u007Fb', 'a\u2028b', 'caf\u00E9'])(
    'refuse une valeur non ASCII imprimable (%j)',
    (value) => {
      expect(validateCustomHeaders({ 'X-Test': value })).toContain(
        'ASCII imprimable',
      );
    },
  );

  it('plafonne le nom à 126 caractères', () => {
    const ok = `X-${'a'.repeat(MAX_HEADER_NAME_LENGTH - 2)}`;

    expect(validateCustomHeaders({ [ok]: 'v' })).toBeNull();
    expect(validateCustomHeaders({ [`${ok}a`]: 'v' })).toContain('dépasse 126');
  });

  it('plafonne le nom et la valeur réunis à 996 caractères', () => {
    // Nom de 10 caractères : la valeur peut aller jusqu'à 986.
    const name = 'X-Campagne';
    const room = MAX_HEADER_TOTAL_LENGTH - name.length;

    expect(validateCustomHeaders({ [name]: 'a'.repeat(room) })).toBeNull();
    expect(validateCustomHeaders({ [name]: 'a'.repeat(room + 1) })).toContain(
      'réunis',
    );
  });

  it.each(['X-', 'x-'])(
    'refuse le nom %s sans rien après le préfixe',
    (name) => {
      expect(validateCustomHeaders({ [name]: 'v' })).toContain('pas autorisé');
    },
  );

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

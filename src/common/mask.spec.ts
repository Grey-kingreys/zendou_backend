import { maskSecret } from './mask';

describe('maskSecret', () => {
  it('garde le préfixe et les quatre derniers caractères', () => {
    expect(maskSecret('zd_live_cle_secrete_0123456789abcd')).toBe(
      'zd_live_****abcd',
    );
  });

  it('ne laisse jamais filtrer le milieu du secret', () => {
    const secret = 'zd_live_UNE_PARTIE_TRES_SENSIBLE_9999';

    const masked = maskSecret(secret);

    expect(masked).not.toContain('SENSIBLE');
    expect(masked).not.toContain('PARTIE');
    // Ce qui reste tient dans le préfixe, le masque et le suffixe : rien
    // d'autre du secret ne peut s'y cacher.
    expect(masked.length).toBe(8 + 4 + 4);
  });

  it('masque entièrement une valeur trop courte pour être découpée', () => {
    // 12 caractères : garder 8 + 4 les révélerait tous.
    expect(maskSecret('zd_live_1234')).toBe('****');
    expect(maskSecret('court')).toBe('****');
    expect(maskSecret('')).toBe('****');
  });

  it('accepte un autre découpage', () => {
    expect(maskSecret('SMTPPASSWORD1234', 2, 2)).toBe('SM****34');
  });

  it('masque tout quand le découpage demandé couvre toute la valeur', () => {
    expect(maskSecret('abcdef', 3, 3)).toBe('****');
  });
});

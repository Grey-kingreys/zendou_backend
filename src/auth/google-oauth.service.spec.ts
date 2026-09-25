import {
  GoogleAuthError,
  decodeIdTokenPayload,
  sanitizeNext,
  statesMatch,
  validateIdTokenClaims,
} from './google-oauth.service';

const NOW = 1_800_000_000;
const expected = { clientId: 'client-id', nonce: 'nonce-1', nowSeconds: NOW };

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: 'client-id',
    exp: NOW + 3600,
    nonce: 'nonce-1',
    sub: 'sub-1',
    email: 'a@gmail.com',
    email_verified: true,
    name: 'A',
    ...overrides,
  };
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof GoogleAuthError ? error.code : 'autre';
  }
  return undefined;
}

describe('validateIdTokenClaims (B30)', () => {
  it('rend l’identité pour des claims valides', () => {
    expect(validateIdTokenClaims(claims(), expected)).toEqual({
      sub: 'sub-1',
      email: 'a@gmail.com',
      name: 'A',
    });
  });

  it('tolère 60 s de décalage d’horloge sur exp, pas davantage', () => {
    expect(
      codeOf(() => validateIdTokenClaims(claims({ exp: NOW - 59 }), expected)),
    ).toBeUndefined();
    expect(
      codeOf(() => validateIdTokenClaims(claims({ exp: NOW - 60 }), expected)),
    ).toBe('google_indisponible');
  });

  it.each([
    [{ iss: 'https://accounts.google.com.evil.com' }, 'google_indisponible'],
    [{ aud: ['client-id'] }, 'google_indisponible'],
    [{ exp: String(NOW + 3600) }, 'google_indisponible'],
    [{ nonce: undefined }, 'google_session_expiree'],
    [{ email_verified: 1 }, 'google_email_non_verifie'],
    [{ sub: '' }, 'google_indisponible'],
  ])('refuse %j (%s)', (overrides, code) => {
    expect(
      codeOf(() => validateIdTokenClaims(claims(overrides), expected)),
    ).toBe(code);
  });

  it('refuse toute audience quand GOOGLE_CLIENT_ID est vide', () => {
    expect(
      codeOf(() =>
        validateIdTokenClaims(claims({ aud: '' }), {
          ...expected,
          clientId: '',
        }),
      ),
    ).toBe('google_indisponible');
  });
});

describe('decodeIdTokenPayload (B30)', () => {
  it('décode la charge utile base64url', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'x' })).toString(
      'base64url',
    );
    expect(decodeIdTokenPayload(`e30.${payload}.sig`)).toEqual({ sub: 'x' });
  });

  it.each([['a.b'], ['e30.!!!.sig'], ['']])('refuse %s', (token) => {
    expect(codeOf(() => decodeIdTokenPayload(token))).toBe(
      'google_indisponible',
    );
  });
});

describe('sanitizeNext (B30)', () => {
  it.each([
    ['/dashboard/cles', '/dashboard/cles'],
    ['/dashboard?onglet=cles#haut', '/dashboard?onglet=cles#haut'],
    ['//evil.com', '/dashboard'],
    ['https://evil.com', '/dashboard'],
    ['/\\evil.com', '/dashboard'],
    ['evil.com', '/dashboard'],
    ['javascript:alert(1)', '/dashboard'],
    ['/ok\r\nSet-Cookie: x=y', '/dashboard'],
    ['', '/dashboard'],
    [undefined, '/dashboard'],
    [['/a', '/b'], '/dashboard'],
    [`/${'a'.repeat(600)}`, '/dashboard'],
  ])('%j donne %s', (next, result) => {
    expect(sanitizeNext(next)).toBe(result);
  });
});

describe('statesMatch (B30)', () => {
  it('compare à longueur égale, refuse les longueurs différentes', () => {
    expect(statesMatch('abc', 'abc')).toBe(true);
    expect(statesMatch('abc', 'abd')).toBe(false);
    expect(statesMatch('abc', 'abcd')).toBe(false);
  });
});

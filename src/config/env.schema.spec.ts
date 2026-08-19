import {
  SMTP_DEFAULT_MAX_CLIENTS,
  SMTP_DEFAULT_SOCKET_TIMEOUT_MS,
  SMTP_NO_LISTENING_PORT_MESSAGE,
  SMTP_TLS_CERTIFICATE_REQUIRED_MESSAGE,
} from '../smtp/smtp-relay.constants';
import { validateEnv } from './env.schema';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://zendou:zendou@localhost:5433/zendou',
  REDIS_URL: 'redis://localhost:6379',
  FRONTEND_ORIGIN: 'http://localhost:3000',
};

/**
 * Variables exigées uniquement quand `NODE_ENV=production` : à ajouter à
 * `BASE_ENV` dans les cas qui doivent démarrer en production.
 */
const PRODUCTION_REQUIRED = {
  SYSTEM_EMAIL_FROM: 'no-reply@mail.kingreys.fr',
};

describe('validateEnv — SNS_SKIP_SIGNATURE_VALIDATION', () => {
  it('defaults to false', () => {
    expect(validateEnv({ ...BASE_ENV }).SNS_SKIP_SIGNATURE_VALIDATION).toBe(
      false,
    );
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['', false],
    ['nimportequoi', false],
  ])('reads %s as %s', (raw, expected) => {
    const env = validateEnv({
      ...BASE_ENV,
      SNS_SKIP_SIGNATURE_VALIDATION: raw,
    });

    expect(env.SNS_SKIP_SIGNATURE_VALIDATION).toBe(expected);
  });

  it('refuses to boot in production with the flag on', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        SNS_SKIP_SIGNATURE_VALIDATION: 'true',
      }),
    ).toThrow(/SNS_SKIP_SIGNATURE_VALIDATION/);
  });

  it('still boots in production when the flag is off', () => {
    const env = validateEnv({
      ...BASE_ENV,
      ...PRODUCTION_REQUIRED,
      NODE_ENV: 'production',
    });

    expect(env.SNS_SKIP_SIGNATURE_VALIDATION).toBe(false);
  });
});

describe('validateEnv — ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME', () => {
  it('boots without any admin variable configured', () => {
    const env = validateEnv({ ...BASE_ENV });

    expect(env.ADMIN_EMAIL).toBeUndefined();
    expect(env.ADMIN_PASSWORD).toBeUndefined();
    expect(env.ADMIN_NAME).toBe('Administrateur Zendou');
  });

  it('boots when both ADMIN_EMAIL and ADMIN_PASSWORD are empty strings', () => {
    const env = validateEnv({
      ...BASE_ENV,
      ADMIN_EMAIL: '',
      ADMIN_PASSWORD: '',
    });

    expect(env.ADMIN_EMAIL).toBeUndefined();
    expect(env.ADMIN_PASSWORD).toBeUndefined();
  });

  it('accepts a valid, fully configured admin account', () => {
    const env = validateEnv({
      ...BASE_ENV,
      ADMIN_EMAIL: 'admin@zendou.gn',
      ADMIN_PASSWORD: 'motdepasse-solide',
      ADMIN_NAME: 'Souleymane',
    });

    expect(env.ADMIN_EMAIL).toBe('admin@zendou.gn');
    expect(env.ADMIN_PASSWORD).toBe('motdepasse-solide');
    expect(env.ADMIN_NAME).toBe('Souleymane');
  });

  it('defaults ADMIN_NAME when not provided', () => {
    const env = validateEnv({
      ...BASE_ENV,
      ADMIN_EMAIL: 'admin@zendou.gn',
      ADMIN_PASSWORD: 'motdepasse-solide',
    });

    expect(env.ADMIN_NAME).toBe('Administrateur Zendou');
  });

  it('rejects ADMIN_EMAIL without ADMIN_PASSWORD (incoherent config)', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, ADMIN_EMAIL: 'admin@zendou.gn' }),
    ).toThrow(/ADMIN_EMAIL/);
  });

  it('rejects ADMIN_PASSWORD without ADMIN_EMAIL (incoherent config)', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, ADMIN_PASSWORD: 'motdepasse-solide' }),
    ).toThrow(/ADMIN_EMAIL/);
  });

  it('rejects an invalid ADMIN_EMAIL', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        ADMIN_EMAIL: 'not-an-email',
        ADMIN_PASSWORD: 'motdepasse-solide',
      }),
    ).toThrow(/ADMIN_EMAIL/);
  });

  it('rejects an ADMIN_PASSWORD shorter than 12 characters', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        ADMIN_EMAIL: 'admin@zendou.gn',
        ADMIN_PASSWORD: 'court',
      }),
    ).toThrow(/ADMIN_PASSWORD/);
  });
});

describe('validateEnv — SYSTEM_EMAIL_FROM', () => {
  it('accepts a bare address', () => {
    const env = validateEnv({
      ...BASE_ENV,
      SYSTEM_EMAIL_FROM: 'no-reply@mail.kingreys.fr',
    });

    expect(env.SYSTEM_EMAIL_FROM).toBe('no-reply@mail.kingreys.fr');
  });

  it('accepts an address with a display name', () => {
    const env = validateEnv({
      ...BASE_ENV,
      SYSTEM_EMAIL_FROM: 'Zendou <no-reply@mail.kingreys.fr>',
    });

    expect(env.SYSTEM_EMAIL_FROM).toBe('Zendou <no-reply@mail.kingreys.fr>');
  });

  it('accepts a quoted display name', () => {
    const env = validateEnv({
      ...BASE_ENV,
      SYSTEM_EMAIL_FROM: '"Zendou, Inc." <no-reply@mail.kingreys.fr>',
    });

    expect(env.SYSTEM_EMAIL_FROM).toBe(
      '"Zendou, Inc." <no-reply@mail.kingreys.fr>',
    );
  });

  it('rejects a value that is not an email address', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, SYSTEM_EMAIL_FROM: 'pas-une-adresse' }),
    ).toThrow(/SYSTEM_EMAIL_FROM/);
  });

  it('rejects a display name with an empty address', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, SYSTEM_EMAIL_FROM: 'Zendou <>' }),
    ).toThrow(/SYSTEM_EMAIL_FROM/);
  });

  it('rejects trailing content after the closing chevron', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        SYSTEM_EMAIL_FROM: 'Zendou <no-reply@mail.kingreys.fr> suffixe',
      }),
    ).toThrow(/SYSTEM_EMAIL_FROM/);
  });
});

describe('validateEnv — relais SMTP (B6/S5)', () => {
  it('leaves the relay off by default, on every environment', () => {
    const env = validateEnv({ ...BASE_ENV });

    expect(env.SMTP_RELAY_ENABLED).toBe(false);
  });

  it('applies the documented default ports', () => {
    const env = validateEnv({ ...BASE_ENV });

    expect(env.SMTP_PORTS_STARTTLS).toEqual([587, 2525]);
    expect(env.SMTP_PORTS_TLS).toEqual([465]);
  });

  it('parses a comma separated port list, trimming spaces', () => {
    const env = validateEnv({
      ...BASE_ENV,
      SMTP_PORTS_STARTTLS: ' 587 , 2525 ',
      SMTP_PORTS_TLS: '465',
    });

    expect(env.SMTP_PORTS_STARTTLS).toEqual([587, 2525]);
    expect(env.SMTP_PORTS_TLS).toEqual([465]);
  });

  it('lets one port family be switched off with an empty value', () => {
    const env = validateEnv({ ...BASE_ENV, SMTP_PORTS_TLS: '' });

    expect(env.SMTP_PORTS_TLS).toEqual([]);
    expect(env.SMTP_PORTS_STARTTLS).toEqual([587, 2525]);
  });

  it.each([['0'], ['65536'], ['587,abc'], ['-1']])(
    'rejects %s as a port list',
    (raw) => {
      expect(() =>
        validateEnv({ ...BASE_ENV, SMTP_PORTS_STARTTLS: raw }),
      ).toThrow(/SMTP_PORTS_STARTTLS/);
    },
  );

  it('rejects a duplicated port, which would fail with EADDRINUSE at boot', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, SMTP_PORTS_STARTTLS: '587,587' }),
    ).toThrow(/plusieurs fois/);
  });

  /**
   * §1.4 / A19 — la règle dure : en production, un relais activé sans
   * certificat ne démarre pas. On ne démarre jamais un serveur de soumission
   * en clair.
   */
  describe('production + relais activé ⇒ certificats obligatoires', () => {
    const PRODUCTION_RELAY = {
      ...BASE_ENV,
      ...PRODUCTION_REQUIRED,
      NODE_ENV: 'production',
      SMTP_RELAY_ENABLED: 'true',
    };

    it.each([
      ['both paths missing', {}],
      [
        'only the certificate',
        { SMTP_TLS_CERT_PATH: '/etc/ssl/fullchain.pem' },
      ],
      ['only the key', { SMTP_TLS_KEY_PATH: '/etc/ssl/privkey.pem' }],
      ['blank paths', { SMTP_TLS_CERT_PATH: '   ', SMTP_TLS_KEY_PATH: '   ' }],
    ])('refuses to boot with %s', (_label, paths) => {
      expect(() => validateEnv({ ...PRODUCTION_RELAY, ...paths })).toThrow(
        SMTP_TLS_CERTIFICATE_REQUIRED_MESSAGE,
      );
    });

    it('boots once both paths are provided', () => {
      const env = validateEnv({
        ...PRODUCTION_RELAY,
        SMTP_TLS_CERT_PATH:
          '/etc/letsencrypt/live/smtp.zendou.app/fullchain.pem',
        SMTP_TLS_KEY_PATH: '/etc/letsencrypt/live/smtp.zendou.app/privkey.pem',
      });

      expect(env.SMTP_RELAY_ENABLED).toBe(true);
      expect(env.SMTP_TLS_CERT_PATH).toBe(
        '/etc/letsencrypt/live/smtp.zendou.app/fullchain.pem',
      );
    });

    it('says nothing when the relay stays off in production', () => {
      const env = validateEnv({ ...PRODUCTION_RELAY, SMTP_RELAY_ENABLED: '' });

      expect(env.SMTP_RELAY_ENABLED).toBe(false);
    });

    it('tolerates a missing certificate outside production', () => {
      const env = validateEnv({ ...BASE_ENV, SMTP_RELAY_ENABLED: 'true' });

      expect(env.SMTP_RELAY_ENABLED).toBe(true);
      expect(env.SMTP_TLS_CERT_PATH).toBeUndefined();
    });
  });

  it('refuses an enabled relay that would listen on nothing at all', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        SMTP_RELAY_ENABLED: 'true',
        SMTP_PORTS_STARTTLS: '',
        SMTP_PORTS_TLS: '',
      }),
    ).toThrow(SMTP_NO_LISTENING_PORT_MESSAGE);
  });

  it('allows empty port lists while the relay is off', () => {
    const env = validateEnv({
      ...BASE_ENV,
      SMTP_PORTS_STARTTLS: '',
      SMTP_PORTS_TLS: '',
    });

    expect(env.SMTP_PORTS_STARTTLS).toEqual([]);
  });

  it('applies the documented caps and reads overrides', () => {
    expect(validateEnv({ ...BASE_ENV }).SMTP_MAX_CLIENTS).toBe(
      SMTP_DEFAULT_MAX_CLIENTS,
    );
    expect(
      validateEnv({ ...BASE_ENV, SMTP_MAX_CLIENTS: '200' }).SMTP_MAX_CLIENTS,
    ).toBe(200);
    // Convention maison : une variable laissée vide vaut « absente », pas zéro.
    expect(
      validateEnv({ ...BASE_ENV, SMTP_SOCKET_TIMEOUT_MS: '' })
        .SMTP_SOCKET_TIMEOUT_MS,
    ).toBe(SMTP_DEFAULT_SOCKET_TIMEOUT_MS);
  });
});

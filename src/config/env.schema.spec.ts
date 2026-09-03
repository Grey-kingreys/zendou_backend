import { RATE_LIMIT_DEFAULTS } from '../rate-limit/rate-limit.constants';
import {
  SMTP_DEFAULT_AUTH_FAILURE_WINDOW_MS,
  SMTP_DEFAULT_AUTH_STUFFING_USERNAME_THRESHOLD,
  SMTP_DEFAULT_CONNECTION_WINDOW_MS,
  SMTP_DEFAULT_MAX_AUTH_FAILURES_PER_CONNECTION,
  SMTP_DEFAULT_MAX_CLIENTS,
  SMTP_DEFAULT_MAX_CONNECTIONS_PER_IP,
  SMTP_DEFAULT_MAX_MESSAGES_PER_CONNECTION,
  SMTP_DEFAULT_MAX_REFUSED_RECIPIENTS_PER_CONNECTION,
  SMTP_DEFAULT_SOCKET_TIMEOUT_MS,
  SMTP_NO_LISTENING_PORT_MESSAGE,
  SMTP_TLS_CERTIFICATE_REQUIRED_MESSAGE,
} from '../smtp/smtp-relay.constants';
import { SMTP_PORT_25_REFUSED_MESSAGE, validateEnv } from './env.schema';

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
  // E3 : le poivre est obligatoire en production, au même titre.
  API_KEY_PEPPER: 'a'.repeat(64),
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

describe('validateEnv — anti-abus du relais SMTP (B6/S9)', () => {
  it('keeps per-IP limits on by default — a protection is never disarmed by omission', () => {
    expect(validateEnv({ ...BASE_ENV }).SMTP_IP_LIMITS_ENABLED).toBe(true);
  });

  it('treats an empty value as absent, not as false', () => {
    // Le piège que cette convention évite : `SMTP_IP_LIMITS_ENABLED=` recopié
    // dans un `.env` couperait silencieusement toutes les limites par IP.
    expect(
      validateEnv({ ...BASE_ENV, SMTP_IP_LIMITS_ENABLED: '' })
        .SMTP_IP_LIMITS_ENABLED,
    ).toBe(true);
    expect(
      validateEnv({ ...BASE_ENV, SMTP_IP_LIMITS_ENABLED: '   ' })
        .SMTP_IP_LIMITS_ENABLED,
    ).toBe(true);
  });

  it.each([['false'], ['0'], ['no'], ['off'], ['anything else']])(
    'disables per-IP limits on an explicit %s',
    (value) => {
      expect(
        validateEnv({ ...BASE_ENV, SMTP_IP_LIMITS_ENABLED: value })
          .SMTP_IP_LIMITS_ENABLED,
      ).toBe(false);
    },
  );

  it.each([['true'], ['1'], ['yes'], ['ON']])(
    'keeps per-IP limits on for %s',
    (value) => {
      expect(
        validateEnv({ ...BASE_ENV, SMTP_IP_LIMITS_ENABLED: value })
          .SMTP_IP_LIMITS_ENABLED,
      ).toBe(true);
    },
  );

  it('applies the documented anti-abuse defaults', () => {
    const env = validateEnv({ ...BASE_ENV });

    expect(env.SMTP_MAX_CONNECTIONS_PER_IP).toBe(
      SMTP_DEFAULT_MAX_CONNECTIONS_PER_IP,
    );
    expect(env.SMTP_CONNECTION_WINDOW_MS).toBe(
      SMTP_DEFAULT_CONNECTION_WINDOW_MS,
    );
    expect(env.SMTP_MAX_AUTH_FAILURES_PER_CONNECTION).toBe(
      SMTP_DEFAULT_MAX_AUTH_FAILURES_PER_CONNECTION,
    );
    expect(env.SMTP_AUTH_FAILURE_WINDOW_MS).toBe(
      SMTP_DEFAULT_AUTH_FAILURE_WINDOW_MS,
    );
    expect(env.SMTP_AUTH_STUFFING_USERNAME_THRESHOLD).toBe(
      SMTP_DEFAULT_AUTH_STUFFING_USERNAME_THRESHOLD,
    );
    expect(env.SMTP_MAX_MESSAGES_PER_CONNECTION).toBe(
      SMTP_DEFAULT_MAX_MESSAGES_PER_CONNECTION,
    );
    expect(env.SMTP_MAX_REFUSED_RECIPIENTS_PER_CONNECTION).toBe(
      SMTP_DEFAULT_MAX_REFUSED_RECIPIENTS_PER_CONNECTION,
    );
  });

  it('gives the SMTP burst limit the same default as the HTTP one, on a separate budget', () => {
    const env = validateEnv({ ...BASE_ENV });

    // §5 : « équivalent SMTP de RATE_LIMIT_EMAILS_PER_MINUTE ». Même
    // tolérance, deux compteurs — un client qui utilise les deux canaux ne
    // doit pas voir chacun amputé par l'autre.
    expect(env.SMTP_EMAILS_PER_MINUTE).toBe(
      RATE_LIMIT_DEFAULTS.EMAILS_PER_MINUTE,
    );
    expect(env.RATE_LIMIT_EMAILS_PER_MINUTE).toBe(env.SMTP_EMAILS_PER_MINUTE);

    const tuned = validateEnv({ ...BASE_ENV, SMTP_EMAILS_PER_MINUTE: '10' });
    expect(tuned.SMTP_EMAILS_PER_MINUTE).toBe(10);
    expect(tuned.RATE_LIMIT_EMAILS_PER_MINUTE).toBe(
      RATE_LIMIT_DEFAULTS.EMAILS_PER_MINUTE,
    );
  });

  it('reads overrides and treats an empty value as absent', () => {
    expect(
      validateEnv({ ...BASE_ENV, SMTP_MAX_CONNECTIONS_PER_IP: '5' })
        .SMTP_MAX_CONNECTIONS_PER_IP,
    ).toBe(5);
    // Convention maison : vide vaut « absente », jamais zéro — une limite
    // tombée à 0 refuserait toutes les connexions.
    expect(
      validateEnv({ ...BASE_ENV, SMTP_MAX_CONNECTIONS_PER_IP: '' })
        .SMTP_MAX_CONNECTIONS_PER_IP,
    ).toBe(SMTP_DEFAULT_MAX_CONNECTIONS_PER_IP);
  });
});

describe('validateEnv - SESSION_COOKIE_DOMAIN (lot D)', () => {
  it('est optionnelle : absente ou vide, le cookie reste hôte-seul', () => {
    expect(validateEnv({ ...BASE_ENV }).SESSION_COOKIE_DOMAIN).toBeUndefined();
    expect(
      validateEnv({ ...BASE_ENV, SESSION_COOKIE_DOMAIN: '' })
        .SESSION_COOKIE_DOMAIN,
    ).toBeUndefined();
    expect(
      validateEnv({ ...BASE_ENV, SESSION_COOKIE_DOMAIN: '   ' })
        .SESSION_COOKIE_DOMAIN,
    ).toBeUndefined();
  });

  it('accepte un nom de domaine nu et le normalise', () => {
    expect(
      validateEnv({ ...BASE_ENV, SESSION_COOKIE_DOMAIN: 'zendou.app' })
        .SESSION_COOKIE_DOMAIN,
    ).toBe('zendou.app');
    // Minuscules, espaces de bord retirés.
    expect(
      validateEnv({ ...BASE_ENV, SESSION_COOKIE_DOMAIN: '  Zendou.App  ' })
        .SESSION_COOKIE_DOMAIN,
    ).toBe('zendou.app');
    // Point initial toléré (notation RFC 2109) et retiré.
    expect(
      validateEnv({ ...BASE_ENV, SESSION_COOKIE_DOMAIN: '.zendou.app' })
        .SESSION_COOKIE_DOMAIN,
    ).toBe('zendou.app');
  });

  it.each([
    ['https://zendou.app'],
    ['zendou.app:443'],
    ['zendou.app/'],
    ['zendou.app/session'],
    ['zendou app'],
  ])('refuse « %s » : un cookie mal formé serait ignoré en silence', (raw) => {
    expect(() =>
      validateEnv({ ...BASE_ENV, SESSION_COOKIE_DOMAIN: raw }),
    ).toThrow(/SESSION_COOKIE_DOMAIN/);
  });
});

describe('validateEnv - API_KEY_PEPPER (E3)', () => {
  it('est optionnelle hors production : le hachage retombe sur le SHA-256 historique', () => {
    expect(validateEnv({ ...BASE_ENV }).API_KEY_PEPPER).toBeUndefined();
    expect(
      validateEnv({ ...BASE_ENV, API_KEY_PEPPER: '' }).API_KEY_PEPPER,
    ).toBeUndefined();
  });

  it('accepte un poivre d’au moins 32 caractères', () => {
    const pepper = 'a'.repeat(64);

    expect(
      validateEnv({ ...BASE_ENV, API_KEY_PEPPER: pepper }).API_KEY_PEPPER,
    ).toBe(pepper);
  });

  it('refuse un poivre trop court pour servir de clé HMAC', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, API_KEY_PEPPER: 'trop-court' }),
    ).toThrow(/API_KEY_PEPPER/);
  });

  it('refuse de démarrer en production sans poivre', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        ...PRODUCTION_REQUIRED,
        NODE_ENV: 'production',
        API_KEY_PEPPER: '',
      }),
    ).toThrow(/API_KEY_PEPPER/);
  });

  it('démarre en production dès que le poivre est fourni', () => {
    expect(
      validateEnv({
        ...BASE_ENV,
        ...PRODUCTION_REQUIRED,
        NODE_ENV: 'production',
      }).API_KEY_PEPPER,
    ).toBe(PRODUCTION_REQUIRED.API_KEY_PEPPER);
  });
});

describe('validateEnv - le port 25 est refusé par configuration (E5)', () => {
  it.each([['SMTP_PORTS_STARTTLS'], ['SMTP_PORTS_TLS']])(
    'refuse 25 dans %s',
    (variable) => {
      expect(() => validateEnv({ ...BASE_ENV, [variable]: '25' })).toThrow(
        SMTP_PORT_25_REFUSED_MESSAGE,
      );
    },
  );

  it('refuse 25 même accompagné de ports légitimes', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, SMTP_PORTS_STARTTLS: '587,25,2525' }),
    ).toThrow(SMTP_PORT_25_REFUSED_MESSAGE);
  });

  it('accepte 587, 2525 et 465, les seuls ports de soumission', () => {
    const env = validateEnv({
      ...BASE_ENV,
      SMTP_PORTS_STARTTLS: '587,2525',
      SMTP_PORTS_TLS: '465',
    });

    expect(env.SMTP_PORTS_STARTTLS).toEqual([587, 2525]);
    expect(env.SMTP_PORTS_TLS).toEqual([465]);
  });
});

describe('validateEnv - MOBILE_MONEY_ORANGE_NUMBER / MOBILE_MONEY_MTN_NUMBER / MOBILE_MONEY_ACCOUNT_NAME (B22)', () => {
  it('boots with none of the three configured', () => {
    const env = validateEnv({ ...BASE_ENV });

    expect(env.MOBILE_MONEY_ORANGE_NUMBER).toBeUndefined();
    expect(env.MOBILE_MONEY_MTN_NUMBER).toBeUndefined();
    expect(env.MOBILE_MONEY_ACCOUNT_NAME).toBeUndefined();
  });

  it('accepts a well-formed number for each method', () => {
    const env = validateEnv({
      ...BASE_ENV,
      MOBILE_MONEY_ORANGE_NUMBER: '+224 620 00 00 00',
      MOBILE_MONEY_MTN_NUMBER: '620000000',
    });

    expect(env.MOBILE_MONEY_ORANGE_NUMBER).toBe('+224 620 00 00 00');
    expect(env.MOBILE_MONEY_MTN_NUMBER).toBe('620000000');
  });

  it('accepts MOBILE_MONEY_ACCOUNT_NAME as a free-form string', () => {
    const env = validateEnv({
      ...BASE_ENV,
      MOBILE_MONEY_ACCOUNT_NAME: 'Zendou SARL',
    });

    expect(env.MOBILE_MONEY_ACCOUNT_NAME).toBe('Zendou SARL');
  });

  it('treats an empty string as absent for all three variables', () => {
    const env = validateEnv({
      ...BASE_ENV,
      MOBILE_MONEY_ORANGE_NUMBER: '',
      MOBILE_MONEY_MTN_NUMBER: '',
      MOBILE_MONEY_ACCOUNT_NAME: '',
    });

    expect(env.MOBILE_MONEY_ORANGE_NUMBER).toBeUndefined();
    expect(env.MOBILE_MONEY_MTN_NUMBER).toBeUndefined();
    expect(env.MOBILE_MONEY_ACCOUNT_NAME).toBeUndefined();
  });

  it.each([['MOBILE_MONEY_ORANGE_NUMBER'], ['MOBILE_MONEY_MTN_NUMBER']])(
    'refuses to boot when %s contains letters',
    (variable) => {
      expect(() =>
        validateEnv({ ...BASE_ENV, [variable]: '622-abc-1122' }),
      ).toThrow(new RegExp(variable));
    },
  );

  it.each([['MOBILE_MONEY_ORANGE_NUMBER'], ['MOBILE_MONEY_MTN_NUMBER']])(
    'refuses to boot when %s has too few digits',
    (variable) => {
      expect(() => validateEnv({ ...BASE_ENV, [variable]: '1234' })).toThrow(
        new RegExp(variable),
      );
    },
  );

  it.each([['MOBILE_MONEY_ORANGE_NUMBER'], ['MOBILE_MONEY_MTN_NUMBER']])(
    'refuses to boot when %s has too many digits',
    (variable) => {
      expect(() =>
        validateEnv({ ...BASE_ENV, [variable]: '1'.repeat(16) }),
      ).toThrow(new RegExp(variable));
    },
  );
});

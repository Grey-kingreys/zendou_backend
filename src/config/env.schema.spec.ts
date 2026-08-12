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

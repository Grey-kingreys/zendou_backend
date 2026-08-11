import { validateEnv } from './env.schema';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://zendou:zendou@localhost:5433/zendou',
  REDIS_URL: 'redis://localhost:6379',
  FRONTEND_ORIGIN: 'http://localhost:3000',
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
    const env = validateEnv({ ...BASE_ENV, NODE_ENV: 'production' });

    expect(env.SNS_SKIP_SIGNATURE_VALIDATION).toBe(false);
  });
});

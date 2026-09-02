import { createHash } from 'crypto';
import {
  SMTP_CREDENTIAL_SECRET_PREFIX,
  generateSmtpCredentialSecret,
  generateSmtpCredentialUsername,
  hashSmtpCredentialSecret,
} from './smtp-credential.utils';

describe('generateSmtpCredentialSecret', () => {
  // E3 : même longueur que les clés API (43 caractères base62 ~ 256 bits).
  it('produces a password in the zd_smtp_ + 43 base62 chars format', () => {
    const { password } = generateSmtpCredentialSecret();

    expect(password.startsWith(SMTP_CREDENTIAL_SECRET_PREFIX)).toBe(true);
    expect(password).toHaveLength(SMTP_CREDENTIAL_SECRET_PREFIX.length + 43);
    expect(password.slice(SMTP_CREDENTIAL_SECRET_PREFIX.length)).toMatch(
      /^[A-Za-z0-9]{43}$/,
    );
  });

  it('derives the prefix from the first 12 characters of the password', () => {
    const { password, prefix } = generateSmtpCredentialSecret();

    expect(prefix).toBe(password.slice(0, 12));
    expect(prefix.startsWith('zd_smtp_')).toBe(true);
  });

  it('stores only the SHA-256 hash of the full password, never the password itself', () => {
    const { password, passwordHash } = generateSmtpCredentialSecret();

    expect(passwordHash).toBe(
      createHash('sha256').update(password).digest('hex'),
    );
    expect(passwordHash).not.toBe(password);
  });

  it('generates distinct secrets on each call', () => {
    const a = generateSmtpCredentialSecret();
    const b = generateSmtpCredentialSecret();

    expect(a.password).not.toBe(b.password);
    expect(a.passwordHash).not.toBe(b.passwordHash);
  });
});

describe('hashSmtpCredentialSecret', () => {
  it('is deterministic', () => {
    expect(hashSmtpCredentialSecret('zd_smtp_abc')).toBe(
      hashSmtpCredentialSecret('zd_smtp_abc'),
    );
  });

  it('matches the generic SHA-256 hash reused from api-key.utils.ts', () => {
    expect(hashSmtpCredentialSecret('zd_smtp_abc')).toBe(
      createHash('sha256').update('zd_smtp_abc').digest('hex'),
    );
  });
});

describe('generateSmtpCredentialUsername', () => {
  it('produces a username in the zdu_ + 16 hex chars format', () => {
    const username = generateSmtpCredentialUsername();

    expect(username.startsWith('zdu_')).toBe(true);
    expect(username).toHaveLength('zdu_'.length + 16);
    expect(username.slice('zdu_'.length)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('generates distinct usernames on each call', () => {
    const a = generateSmtpCredentialUsername();
    const b = generateSmtpCredentialUsername();

    expect(a).not.toBe(b);
  });
});

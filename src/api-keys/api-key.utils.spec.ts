import { createHash } from 'crypto';
import {
  API_KEY_PREFIX,
  extractBearerToken,
  generateApiKey,
  hashApiKey,
} from './api-key.utils';

describe('generateApiKey', () => {
  it('produces a key in the zd_live_ + 40 base62 chars format', () => {
    const { key } = generateApiKey();

    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(API_KEY_PREFIX.length + 40);
    expect(key.slice(API_KEY_PREFIX.length)).toMatch(/^[A-Za-z0-9]{40}$/);
  });

  it('derives the prefix from the first 12 characters of the key', () => {
    const { key, prefix } = generateApiKey();

    expect(prefix).toBe(key.slice(0, 12));
    expect(prefix.startsWith('zd_live_')).toBe(true);
  });

  it('stores only the SHA-256 hash of the full key, never the key itself', () => {
    const { key, keyHash } = generateApiKey();

    expect(keyHash).toBe(createHash('sha256').update(key).digest('hex'));
    expect(keyHash).not.toBe(key);
  });

  it('generates distinct keys on each call', () => {
    const a = generateApiKey();
    const b = generateApiKey();

    expect(a.key).not.toBe(b.key);
    expect(a.keyHash).not.toBe(b.keyHash);
  });
});

describe('hashApiKey', () => {
  it('is deterministic', () => {
    expect(hashApiKey('zd_live_abc')).toBe(hashApiKey('zd_live_abc'));
  });
});

describe('extractBearerToken', () => {
  it('extracts the token from a well-formed Bearer header', () => {
    expect(extractBearerToken('Bearer zd_live_abc123')).toBe('zd_live_abc123');
  });

  it('returns undefined when the header is missing', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it('returns undefined for a malformed scheme', () => {
    expect(extractBearerToken('Basic zd_live_abc123')).toBeUndefined();
  });

  it('returns undefined when the token is empty', () => {
    expect(extractBearerToken('Bearer ')).toBeUndefined();
  });
});

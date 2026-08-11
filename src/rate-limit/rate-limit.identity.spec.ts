import { hashApiKey } from '../api-keys/api-key.utils';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import { UNKNOWN_IP } from './rate-limit.constants';
import {
  ipIdentifier,
  maskTracker,
  normalizeIp,
  readSessionToken,
  resolveApiKeyIdentifier,
  resolveClientIp,
  resolveResolvedUserIdentifier,
  resolveTargetEmail,
  trustProxySetting,
} from './rate-limit.identity';
import type { RateLimitRequest } from './rate-limit.types';

describe('rate-limit.identity', () => {
  describe('resolveClientIp', () => {
    it("retient `req.ip`, c'est-à-dire l'IP réelle issue de X-Forwarded-For", () => {
      // Express pose `req.ip` à partir du dernier saut de confiance de
      // `X-Forwarded-For` dès que `trust proxy` est configuré : c'est bien
      // l'IP du client, pas celle du proxy Traefik.
      expect(resolveClientIp({ ip: '41.66.10.5' })).toBe('41.66.10.5');
    });

    it("ignore l'IP de la socket quand `req.ip` est disponible", () => {
      const request: RateLimitRequest = {
        ip: '41.66.10.5',
        socket: { remoteAddress: '10.0.0.1' }, // l'adresse du proxy
      };

      expect(resolveClientIp(request)).toBe('41.66.10.5');
    });

    it('retombe sur la socket quand `req.ip` est absente', () => {
      expect(resolveClientIp({ socket: { remoteAddress: '10.0.0.1' } })).toBe(
        '10.0.0.1',
      );
    });

    it('normalise les adresses IPv4 encapsulées en IPv6', () => {
      expect(resolveClientIp({ ip: '::ffff:41.66.10.5' })).toBe('41.66.10.5');
      expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    });

    it("renvoie une valeur repli quand aucune IP n'est déterminable", () => {
      expect(resolveClientIp({})).toBe(UNKNOWN_IP);
      expect(resolveClientIp({ ip: '' })).toBe(UNKNOWN_IP);
    });
  });

  describe('resolveApiKeyIdentifier', () => {
    it("préfère l'identifiant déjà résolu par le garde de clé API", () => {
      expect(resolveApiKeyIdentifier({ apiKeyId: 'key-123' })).toBe(
        'apikey:key-123',
      );
    });

    it("dérive un identifiant stable de l'en-tête Authorization", () => {
      const key = 'zd_live_abcdefghijklmnopqrstuvwxyz0123456789ABCD';

      expect(
        resolveApiKeyIdentifier({
          headers: { authorization: `Bearer ${key}` },
        }),
      ).toBe(`apikey:${hashApiKey(key)}`);
    });

    it('ne renvoie jamais la clé en clair', () => {
      const key = 'zd_live_secret';
      const identifier = resolveApiKeyIdentifier({
        headers: { authorization: `Bearer ${key}` },
      });

      expect(identifier).toBeDefined();
      expect(identifier).not.toContain(key);
    });

    it('renvoie `undefined` sans en-tête exploitable', () => {
      expect(resolveApiKeyIdentifier({})).toBeUndefined();
      expect(
        resolveApiKeyIdentifier({ headers: { authorization: 'Basic xyz' } }),
      ).toBeUndefined();
    });
  });

  describe('identité de session', () => {
    it("lit l'utilisateur déjà posé sur la requête", () => {
      expect(resolveResolvedUserIdentifier({ user: { id: 'u-1' } })).toBe(
        'user:u-1',
      );
      expect(resolveResolvedUserIdentifier({})).toBeUndefined();
    });

    it('lit le token de session depuis le cookie', () => {
      expect(
        readSessionToken({ cookies: { [SESSION_COOKIE_NAME]: 'tok' } }),
      ).toBe('tok');
      expect(readSessionToken({ cookies: {} })).toBeUndefined();
      expect(readSessionToken({ cookies: 'pas un objet' })).toBeUndefined();
    });
  });

  describe('resolveTargetEmail', () => {
    it("normalise l'adresse pour qu'une seule casse ne suffise pas à repartir à zéro", () => {
      expect(resolveTargetEmail({ body: { email: '  Foo@Bar.COM ' } })).toBe(
        'email:foo@bar.com',
      );
    });

    it('tolère un corps absent, non objet ou sans email', () => {
      expect(resolveTargetEmail({})).toBeUndefined();
      expect(resolveTargetEmail({ body: 'texte brut SNS' })).toBeUndefined();
      expect(resolveTargetEmail({ body: { email: 42 } })).toBeUndefined();
      expect(resolveTargetEmail({ body: { email: '   ' } })).toBeUndefined();
    });
  });

  describe('maskTracker', () => {
    it('garde la nature du compteur et tronque la valeur', () => {
      expect(maskTracker('user:clx0123456789')).toBe('user:clx01234…');
      expect(maskTracker('email:attaquant@example.com')).toBe(
        'email:attaquan…',
      );
      expect(maskTracker('ip:41.66.10.5')).toBe('ip:41.66.10…');
    });

    it('laisse intactes les valeurs déjà courtes', () => {
      expect(maskTracker('ip:1.2.3.4')).toBe('ip:1.2.3.4');
    });
  });

  describe('trustProxySetting', () => {
    it('fait confiance au nombre de sauts demandé', () => {
      expect(trustProxySetting(1)).toBe(1);
      expect(trustProxySetting(3)).toBe(3);
    });

    it('désactive la confiance à zéro (X-Forwarded-For alors falsifiable)', () => {
      expect(trustProxySetting(0)).toBe(false);
      expect(trustProxySetting(-1)).toBe(false);
      expect(trustProxySetting(Number.NaN)).toBe(false);
    });
  });

  describe('ipIdentifier', () => {
    it("préfixe l'IP pour qu'aucun compteur IP ne collisionne avec un autre type", () => {
      expect(ipIdentifier({ ip: '41.66.10.5' })).toBe('ip:41.66.10.5');
    });
  });
});

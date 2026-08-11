import { Logger } from '@nestjs/common';
import { hashApiKey } from '../api-keys/api-key.utils';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import type { SessionService } from '../auth/session.service';
import { RateLimitTrackerService } from './rate-limit-tracker.service';
import { TRACKER_KIND } from './rate-limit.constants';
import type { RateLimitRequest } from './rate-limit.types';

describe('RateLimitTrackerService', () => {
  let peek: jest.Mock<Promise<string | null>, [string]>;
  let service: RateLimitTrackerService;

  beforeEach(() => {
    peek = jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null);
    service = new RateLimitTrackerService({
      peek,
    } as unknown as SessionService);
  });

  const sessionRequest = (token: string): RateLimitRequest => ({
    ip: '41.66.10.5',
    cookies: { [SESSION_COOKIE_NAME]: token },
  });

  describe('routes authentifiées par session', () => {
    it("compte par userId, résolu depuis le cookie avant tout garde d'auth", async () => {
      peek.mockResolvedValue('user-abc');

      await expect(
        service.resolvePrimary(sessionRequest('tok'), TRACKER_KIND.USER),
      ).resolves.toBe('user:user-abc');
      expect(peek).toHaveBeenCalledWith('tok');
    });

    it('donne le même compteur à deux sessions du même utilisateur', async () => {
      peek.mockResolvedValue('user-abc');

      const first = await service.resolvePrimary(
        sessionRequest('session-1'),
        TRACKER_KIND.USER,
      );
      const second = await service.resolvePrimary(
        { ...sessionRequest('session-2'), ip: '197.149.1.1' },
        TRACKER_KIND.USER,
      );

      expect(first).toBe(second);
    });

    it('donne des compteurs distincts à deux utilisateurs derrière la même IP', async () => {
      peek.mockResolvedValueOnce('user-a').mockResolvedValueOnce('user-b');

      const first = await service.resolvePrimary(
        sessionRequest('session-a'),
        TRACKER_KIND.USER,
      );
      const second = await service.resolvePrimary(
        sessionRequest('session-b'),
        TRACKER_KIND.USER,
      );

      expect(first).toBe('user:user-a');
      expect(second).toBe('user:user-b');
    });

    it("retombe sur l'IP quand la session est inconnue ou absente", async () => {
      await expect(
        service.resolvePrimary(sessionRequest('périmé'), TRACKER_KIND.USER),
      ).resolves.toBe('ip:41.66.10.5');

      await expect(
        service.resolvePrimary({ ip: '41.66.10.5' }, TRACKER_KIND.USER),
      ).resolves.toBe('ip:41.66.10.5');
    });

    it("retombe sur l'IP si Redis est indisponible, sans faire échouer la requête", async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      peek.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.resolvePrimary(sessionRequest('tok'), TRACKER_KIND.USER),
      ).resolves.toBe('ip:41.66.10.5');
    });
  });

  describe('routes authentifiées par clé API', () => {
    const key = 'zd_live_abcdefghijklmnopqrstuvwxyz0123456789ABCD';

    it('compte par identifiant de clé API, pas par IP', async () => {
      await expect(
        service.resolvePrimary(
          { ip: '41.66.10.5', headers: { authorization: `Bearer ${key}` } },
          TRACKER_KIND.API_KEY,
        ),
      ).resolves.toBe(`apikey:${hashApiKey(key)}`);
    });

    it('sépare deux clés API sortant de la même IP', async () => {
      const other = 'zd_live_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

      const first = await service.resolvePrimary(
        { ip: '41.66.10.5', headers: { authorization: `Bearer ${key}` } },
        TRACKER_KIND.API_KEY,
      );
      const second = await service.resolvePrimary(
        { ip: '41.66.10.5', headers: { authorization: `Bearer ${other}` } },
        TRACKER_KIND.API_KEY,
      );

      expect(first).not.toBe(second);
    });

    it("retombe sur l'IP quand aucune clé n'est présentée", async () => {
      await expect(
        service.resolvePrimary({ ip: '41.66.10.5' }, TRACKER_KIND.API_KEY),
      ).resolves.toBe('ip:41.66.10.5');
    });
  });

  describe('politique par défaut', () => {
    it('privilégie la clé API, puis la session, puis l’IP', async () => {
      const key = 'zd_live_key';
      peek.mockResolvedValue('user-abc');

      await expect(
        service.resolvePrimary(
          {
            ip: '41.66.10.5',
            headers: { authorization: `Bearer ${key}` },
            cookies: { [SESSION_COOKIE_NAME]: 'tok' },
          },
          TRACKER_KIND.IDENTITY,
        ),
      ).resolves.toBe(`apikey:${hashApiKey(key)}`);

      await expect(
        service.resolvePrimary(sessionRequest('tok'), TRACKER_KIND.IDENTITY),
      ).resolves.toBe('user:user-abc');

      peek.mockResolvedValue(null);
      await expect(
        service.resolvePrimary({ ip: '41.66.10.5' }, TRACKER_KIND.IDENTITY),
      ).resolves.toBe('ip:41.66.10.5');
    });
  });

  describe('routes non authentifiées', () => {
    const request: RateLimitRequest = {
      ip: '41.66.10.5',
      body: { email: 'Cible@Example.com' },
    };

    it('compte par IP en principal et par email visé en secondaire', async () => {
      await expect(
        service.resolvePrimary(request, TRACKER_KIND.IP_AND_EMAIL),
      ).resolves.toBe('ip:41.66.10.5');

      expect(service.resolveSecondary(request, TRACKER_KIND.IP_AND_EMAIL)).toBe(
        'email:cible@example.com',
      );
    });

    it("n'a pas de compteur secondaire sur les autres politiques", () => {
      expect(
        service.resolveSecondary(request, TRACKER_KIND.USER),
      ).toBeUndefined();
      expect(
        service.resolveSecondary(request, TRACKER_KIND.IP),
      ).toBeUndefined();
    });

    it("n'invente pas de compteur secondaire sans email dans le corps", () => {
      expect(
        service.resolveSecondary(
          { ip: '41.66.10.5' },
          TRACKER_KIND.IP_AND_EMAIL,
        ),
      ).toBeUndefined();
    });

    it('ne consulte jamais Redis pour une route non authentifiée', async () => {
      await service.resolvePrimary(request, TRACKER_KIND.IP_AND_EMAIL);
      expect(peek).not.toHaveBeenCalled();
    });
  });
});

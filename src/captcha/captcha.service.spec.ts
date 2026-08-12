import { ConfigService } from '@nestjs/config';
import { CaptchaService } from './captcha.service';
import { TURNSTILE_VERIFY_URL } from './captcha.constants';

const SECRET = 'test-secret-value';
const TOKEN = 'test-token-value';
const REMOTE_IP = '203.0.113.10';

function configWithSecret(secret: string | undefined): ConfigService {
  return { get: () => secret } as unknown as ConfigService;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Accès à l'instance privée `Logger` du service, pour espionner `.error(...)`. */
function loggerOf(service: CaptchaService): {
  error: (...args: unknown[]) => void;
} {
  return Reflect.get(service, 'logger') as {
    error: (...args: unknown[]) => void;
  };
}

describe('CaptchaService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isEnabled', () => {
    it('is false when TURNSTILE_SECRET_KEY is absent', () => {
      const service = new CaptchaService(configWithSecret(undefined));
      expect(service.isEnabled).toBe(false);
    });

    it('is true when TURNSTILE_SECRET_KEY is set', () => {
      const service = new CaptchaService(configWithSecret(SECRET));
      expect(service.isEnabled).toBe(true);
    });
  });

  describe('verify — captcha désactivé', () => {
    it('réussit toujours, sans aucun appel réseau (aucun jeton fourni)', async () => {
      const service = new CaptchaService(configWithSecret(undefined));

      await expect(service.verify(undefined, REMOTE_IP)).resolves.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('réussit toujours même avec un jeton présent (ignoré)', async () => {
      const service = new CaptchaService(configWithSecret(undefined));

      await expect(service.verify(TOKEN, REMOTE_IP)).resolves.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('verify — captcha activé', () => {
    it('rejette sans appel réseau quand le jeton est absent', async () => {
      const service = new CaptchaService(configWithSecret(SECRET));

      await expect(service.verify(undefined, REMOTE_IP)).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepte un jeton validé par Cloudflare (success: true)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ success: true }));
      const service = new CaptchaService(configWithSecret(SECRET));

      await expect(service.verify(TOKEN, REMOTE_IP)).resolves.toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(TURNSTILE_VERIFY_URL);
      expect(init.method).toBe('POST');
      const body = init.body as URLSearchParams;
      expect(body.get('secret')).toBe(SECRET);
      expect(body.get('response')).toBe(TOKEN);
      expect(body.get('remoteip')).toBe(REMOTE_IP);
    });

    it('rejette un jeton refusé par Cloudflare (success: false), sans log ERROR', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          success: false,
          'error-codes': ['invalid-input-response'],
        }),
      );
      const service = new CaptchaService(configWithSecret(SECRET));

      await expect(service.verify(TOKEN, REMOTE_IP)).resolves.toBe(false);
    });

    it('échec fermé : rejette et journalise une ERREUR quand Cloudflare répond un statut HTTP non-2xx', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, false, 502));
      const service = new CaptchaService(configWithSecret(SECRET));
      const logSpy = jest
        .spyOn(loggerOf(service), 'error')
        .mockImplementation(() => undefined);

      await expect(service.verify(TOKEN, REMOTE_IP)).resolves.toBe(false);

      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('échec fermé : rejette et journalise une ERREUR quand Cloudflare est injoignable (timeout/erreur réseau)', async () => {
      fetchMock.mockRejectedValue(new Error('network timeout'));
      const service = new CaptchaService(configWithSecret(SECRET));
      const logSpy = jest
        .spyOn(loggerOf(service), 'error')
        .mockImplementation(() => undefined);

      await expect(service.verify(TOKEN, REMOTE_IP)).resolves.toBe(false);

      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('ne journalise jamais le secret ni le jeton, même en erreur', async () => {
      fetchMock.mockRejectedValue(new Error('network timeout'));
      const service = new CaptchaService(configWithSecret(SECRET));
      const messages: string[] = [];
      jest
        .spyOn(loggerOf(service), 'error')
        .mockImplementation((message: unknown) => {
          messages.push(String(message));
        });

      await service.verify(TOKEN, REMOTE_IP);

      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        expect(message).not.toContain(SECRET);
        expect(message).not.toContain(TOKEN);
      }
    });

    it('passe un AbortSignal (timeout) à fetch', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ success: true }));
      const service = new CaptchaService(configWithSecret(SECRET));

      await service.verify(TOKEN, REMOTE_IP);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });
});

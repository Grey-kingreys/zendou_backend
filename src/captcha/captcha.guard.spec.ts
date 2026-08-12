import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { CaptchaGuard } from './captcha.guard';
import type { CaptchaService } from './captcha.service';
import { CAPTCHA_FAILED_MESSAGE } from './captcha.constants';

interface CaptchaServiceMock {
  isEnabled: boolean;
  verify: jest.Mock;
}

function captchaServiceMock(isEnabled: boolean): CaptchaServiceMock {
  return { isEnabled, verify: jest.fn() };
}

function asCaptchaService(mock: CaptchaServiceMock): CaptchaService {
  return mock as unknown as CaptchaService;
}

function contextWith(
  body: unknown,
  headers: Record<string, unknown> = {},
): ExecutionContext {
  const request = {
    body,
    headers,
    ip: '203.0.113.10',
    socket: { remoteAddress: '203.0.113.10' },
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('CaptchaGuard', () => {
  it('laisse toujours passer quand le captcha est désactivé, sans appeler verify', async () => {
    const captchaService = captchaServiceMock(false);
    const guard = new CaptchaGuard(asCaptchaService(captchaService));

    await expect(
      guard.canActivate(contextWith({ captchaToken: 'whatever' })),
    ).resolves.toBe(true);

    expect(captchaService.verify).not.toHaveBeenCalled();
  });

  it('laisse toujours passer quand le captcha est désactivé, même sans jeton', async () => {
    const captchaService = captchaServiceMock(false);
    const guard = new CaptchaGuard(asCaptchaService(captchaService));

    await expect(guard.canActivate(contextWith({}))).resolves.toBe(true);

    expect(captchaService.verify).not.toHaveBeenCalled();
  });

  describe('captcha activé', () => {
    it('laisse passer un jeton valide et transmet la vraie IP client', async () => {
      const captchaService = captchaServiceMock(true);
      captchaService.verify.mockResolvedValue(true);
      const guard = new CaptchaGuard(asCaptchaService(captchaService));

      await expect(
        guard.canActivate(contextWith({ captchaToken: 'jeton-valide' })),
      ).resolves.toBe(true);

      expect(captchaService.verify).toHaveBeenCalledWith(
        'jeton-valide',
        '203.0.113.10',
      );
    });

    it('rejette avec 400 quand le jeton est absent du corps', async () => {
      const captchaService = captchaServiceMock(true);
      captchaService.verify.mockResolvedValue(false);
      const guard = new CaptchaGuard(asCaptchaService(captchaService));

      await expect(guard.canActivate(contextWith({}))).rejects.toMatchObject(
        new BadRequestException(CAPTCHA_FAILED_MESSAGE),
      );

      expect(captchaService.verify).toHaveBeenCalledWith(
        undefined,
        '203.0.113.10',
      );
    });

    it('rejette avec 400 quand verify() renvoie false (jeton refusé, ou Cloudflare injoignable)', async () => {
      const captchaService = captchaServiceMock(true);
      captchaService.verify.mockResolvedValue(false);
      const guard = new CaptchaGuard(asCaptchaService(captchaService));

      await expect(
        guard.canActivate(contextWith({ captchaToken: 'jeton-refuse' })),
      ).rejects.toMatchObject(new BadRequestException(CAPTCHA_FAILED_MESSAGE));
    });

    it('ignore un captchaToken qui ne serait pas une chaîne', async () => {
      const captchaService = captchaServiceMock(true);
      captchaService.verify.mockResolvedValue(false);
      const guard = new CaptchaGuard(asCaptchaService(captchaService));

      await expect(
        guard.canActivate(contextWith({ captchaToken: 12345 })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(captchaService.verify).toHaveBeenCalledWith(
        undefined,
        '203.0.113.10',
      );
    });
  });
});

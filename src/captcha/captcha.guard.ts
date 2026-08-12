import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { resolveClientIp } from '../rate-limit/rate-limit.identity';
import type { RateLimitRequest } from '../rate-limit/rate-limit.types';
import { CAPTCHA_FAILED_MESSAGE } from './captcha.constants';
import { CaptchaService } from './captcha.service';

/**
 * Garde posé uniquement sur `POST /v1/auth/register` (voir
 * `AuthController`) — nulle part ailleurs : la connexion s'appuie déjà sur la
 * limitation de débit, l'API d'envoi est machine-à-machine, et le webhook SNS
 * est appelé par AWS.
 *
 * Quand `CaptchaService.isEnabled` est faux, laisse toujours passer (le champ
 * `captchaToken`, s'il est présent dans le corps, est simplement ignoré).
 */
@Injectable()
export class CaptchaGuard implements CanActivate {
  constructor(private readonly captchaService: CaptchaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.captchaService.isEnabled) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RateLimitRequest>();
    const token = extractCaptchaToken(request.body);
    const remoteIp = resolveClientIp(request);

    const valid = await this.captchaService.verify(token, remoteIp);

    if (!valid) {
      throw new BadRequestException(CAPTCHA_FAILED_MESSAGE);
    }

    return true;
  }
}

function extractCaptchaToken(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const token = (body as Record<string, unknown>).captchaToken;

  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

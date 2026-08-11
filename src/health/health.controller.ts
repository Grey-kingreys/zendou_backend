import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { RateLimitExempt } from '../rate-limit/rate-limit.decorator';
import { HealthService, HealthStatus } from './health.service';

/**
 * Sonde de santé — **exemptée** de limitation de débit : le `HEALTHCHECK` du
 * Dockerfile l'appelle toutes les 30 secondes, indéfiniment. Comptée, elle
 * finirait par épuiser son propre quota et ferait passer le conteneur en
 * *unhealthy*, provoquant exactement l'indisponibilité qu'on cherche à
 * éviter.
 */
@Controller('health')
@RateLimitExempt()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async check(): Promise<HealthStatus> {
    const result = await this.healthService.check();

    if (result.status !== 'ok') {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return result;
  }
}

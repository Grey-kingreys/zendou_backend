import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { RateLimitCoreModule } from '../rate-limit/rate-limit-core.module';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { SecretHashingService } from './secret-hashing.service';

/**
 * `RateLimitCoreModule` apporte `RedisThrottlerStorage`, le compteur partagé
 * des échecs d'authentification par IP (lot C). Aucun cycle : ce module-là
 * n'importe qu'`AuthModule`, qui ignore tout des clés API.
 */
@Module({
  imports: [AuthModule, RateLimitCoreModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService, ApiKeyAuthGuard, SecretHashingService],
  exports: [ApiKeysService, ApiKeyAuthGuard, SecretHashingService],
})
export class ApiKeysModule {}

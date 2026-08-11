import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AuthModule } from '../auth/auth.module';
import { RateLimitPolicyService } from './rate-limit-policy.service';
import { RateLimitTrackerService } from './rate-limit-tracker.service';
import { RATE_LIMIT_REDIS } from './rate-limit.constants';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Briques de la limitation de débit, isolées dans leur propre module parce
 * que `ThrottlerModule.forRootAsync` doit pouvoir les injecter dans sa
 * fabrique d'options — ce qui serait circulaire si elles vivaient dans le
 * module qui importe `ThrottlerModule`.
 *
 * `AuthModule` est importé pour `SessionService` : c'est lui qui permet de
 * traduire un cookie de session en identifiant utilisateur avant même que le
 * garde d'authentification ne s'exécute.
 */
@Module({
  imports: [AuthModule],
  providers: [
    {
      provide: RATE_LIMIT_REDIS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis => {
        const logger = new Logger('RateLimitStore');
        const client = new Redis(configService.get<string>('REDIS_URL')!, {
          lazyConnect: true,
          // Un compteur ne doit jamais faire tomber l'API : en cas de coupure
          // Redis, on préfère laisser passer la requête plutôt que d'empiler
          // des tentatives à l'infini.
          maxRetriesPerRequest: 2,
        });
        client.on('error', (error: Error) => {
          logger.error('Redis rate-limit store error', error);
        });
        return client;
      },
    },
    RedisThrottlerStorage,
    RateLimitTrackerService,
    RateLimitPolicyService,
  ],
  exports: [
    RedisThrottlerStorage,
    RateLimitTrackerService,
    RateLimitPolicyService,
  ],
})
export class RateLimitCoreModule {}

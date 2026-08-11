import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { RateLimitCoreModule } from './rate-limit-core.module';
import { RateLimitPolicyService } from './rate-limit-policy.service';
import { RateLimitTrackerService } from './rate-limit-tracker.service';
import { RateLimitGuard } from './rate-limit.guard';
import { buildThrottlerOptions } from './rate-limit.options';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Limitation de débit de toute l'API.
 *
 * Le garde est enregistré en `APP_GUARD`, donc appliqué à chaque route sans
 * décorateur à poser : une route nouvelle est protégée par défaut (120/min
 * par identité). Les routes sensibles resserrent la vis via `@RateLimit(...)`
 * et `/health` s'en exempte via `@RateLimitExempt()`.
 */
@Module({
  imports: [
    RateLimitCoreModule,
    ThrottlerModule.forRootAsync({
      imports: [RateLimitCoreModule],
      inject: [
        RateLimitPolicyService,
        RateLimitTrackerService,
        RedisThrottlerStorage,
      ],
      useFactory: buildThrottlerOptions,
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class RateLimitModule {}

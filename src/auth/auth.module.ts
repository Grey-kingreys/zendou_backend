import { Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CaptchaModule } from '../captcha/captcha.module';
import { EmailsCoreModule } from '../emails/emails-core.module';
import { SESSION_REDIS } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailConfirmationService } from './email-confirmation.service';
import { EmailVerifiedGuard } from './email-verified.guard';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleOAuthService } from './google-oauth.service';
import { LoginLockoutService } from './login-lockout.service';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';

/**
 * `EmailsCoreModule` — et non `EmailsModule` — pour l'expédition des emails
 * système : le second importe `ApiKeysModule`, qui importe `AuthModule`, donc
 * le cycle serait immédiat. Voir `emails-core.module.ts`.
 */
@Module({
  imports: [CaptchaModule, EmailsCoreModule],
  controllers: [AuthController, GoogleAuthController],
  providers: [
    {
      provide: SESSION_REDIS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis => {
        const logger = new Logger('SessionStore');
        const client = new Redis(configService.get<string>('REDIS_URL')!, {
          lazyConnect: true,
        });
        client.on('error', (error: Error) => {
          logger.error('Redis session store error', error);
        });
        return client;
      },
    },
    AuthService,
    SessionService,
    SessionAuthGuard,
    EmailConfirmationService,
    EmailVerifiedGuard,
    // Partage le client Redis des sessions : mêmes contraintes de
    // disponibilité, même politique de repli, un seul pool de connexions.
    LoginLockoutService,
    // Même client Redis que les sessions pour l'état OAuth (B30).
    GoogleOAuthService,
  ],
  exports: [
    AuthService,
    SessionService,
    SessionAuthGuard,
    EmailConfirmationService,
    EmailVerifiedGuard,
  ],
})
export class AuthModule implements OnModuleDestroy {
  constructor(@Inject(SESSION_REDIS) private readonly redis: Redis) {}

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}

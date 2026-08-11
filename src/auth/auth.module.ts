import { Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { SESSION_REDIS } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController],
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
  ],
  exports: [AuthService, SessionService, SessionAuthGuard],
})
export class AuthModule implements OnModuleDestroy {
  constructor(@Inject(SESSION_REDIS) private readonly redis: Redis) {}

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}

import {
  Global,
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AuthModule } from '../auth/auth.module';
import { ReputationController } from './reputation.controller';
import { REPUTATION_REDIS } from './reputation.constants';
import { ReputationService } from './reputation.service';

/**
 * Protection anti-abus : seuils de rebond/plainte, suspension automatique et
 * montée en charge progressive.
 *
 * `@Global` comme `PrismaModule` : le service est injecté depuis des points
 * transverses (webhook SNS, worker d'envoi) sans que ces modules aient à
 * déclarer une dépendance à la protection anti-abus.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [ReputationController],
  providers: [
    {
      provide: REPUTATION_REDIS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis => {
        const logger = new Logger('ReputationThrottle');
        const client = new Redis(configService.get<string>('REDIS_URL')!, {
          lazyConnect: true,
        });
        client.on('error', (error: Error) => {
          logger.error('Redis reputation throttle error', error);
        });
        return client;
      },
    },
    ReputationService,
  ],
  exports: [ReputationService],
})
export class ReputationModule implements OnModuleDestroy {
  constructor(@Inject(REPUTATION_REDIS) private readonly redis: Redis) {}

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}

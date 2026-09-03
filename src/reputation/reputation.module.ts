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
import { EmailsCoreModule } from '../emails/emails-core.module';
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
 *
 * `EmailsCoreModule` (et non `EmailsModule`) porte l'expédition de l'alerte de
 * suspension automatique (E2) : le second importe `ApiKeysModule`, qui importe
 * `AuthModule`. Le premier ne dépend que de la file BullMQ, n'importe pas
 * `ReputationModule` et n'injecte pas `ReputationService` : aucun cycle, donc
 * aucun `forwardRef`. C'est la même raison qui fait qu'`AuthModule` l'importe
 * lui aussi, et `reputation-emails.module.spec.ts` le prouve en compilant les
 * deux modules ensemble.
 */
@Global()
@Module({
  imports: [AuthModule, EmailsCoreModule],
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

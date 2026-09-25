import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import { RETENTION_CLOCK } from './retention.constants';
import {
  BullRetentionScheduler,
  RETENTION_SCHEDULER,
} from './retention.scheduler';
import { RetentionService } from './retention.service';

/**
 * Rétention automatique des données d'envoi (RET-12).
 *
 * Importé **sans condition** dans `AppModule`, contrairement à
 * `SmtpCertAlertModule` : la purge n'est pas une fonctionnalité qui peut être
 * désactivée par configuration, elle applique une promesse de la politique de
 * confidentialité (`/confidentialite`).
 *
 * `BullModule.registerQueue({ name: EMAIL_SEND_QUEUE })` réutilise le même
 * nom de file que `EmailsModule` (et `AppModule`) : c'est ainsi que
 * `@nestjs/bullmq` partage la connexion et le jeton d'injection de la file
 * `email-send` entre modules, sans ouvrir de seconde connexion Redis pour la
 * même file. `PrismaModule` et `ConfigModule` sont globaux : rien d'autre à
 * importer.
 */
@Module({
  imports: [BullModule.registerQueue({ name: EMAIL_SEND_QUEUE })],
  providers: [
    { provide: RETENTION_CLOCK, useValue: () => new Date() },
    { provide: RETENTION_SCHEDULER, useClass: BullRetentionScheduler },
    RetentionService,
  ],
})
export class RetentionModule {}

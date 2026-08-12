import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ApiKeysModule } from '../api-keys';
import { AuthModule } from '../auth/auth.module';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import { EmailSendProcessor } from './email-send.processor';
import { EmailsController } from './emails.controller';
import { EmailsCoreModule } from './emails-core.module';
import { sesSendDriverProvider } from './ses/ses-send-driver.factory';

/**
 * Pipeline d'envoi : acceptation (`POST /v1/emails`), file BullMQ et
 * worker SES. Distinct d'`EmailsLogModule`, qui ne fait que lire.
 *
 * `EmailsService` vit dans `EmailsCoreModule` : `AuthModule` l'y prend sans
 * fermer de cycle (voir ce module). `AuthModule` est importé ici pour
 * `EmailVerifiedGuard`, posé sur `POST /v1/emails`.
 */
@Module({
  imports: [
    ApiKeysModule,
    AuthModule,
    EmailsCoreModule,
    BullModule.registerQueue({ name: EMAIL_SEND_QUEUE }),
  ],
  controllers: [EmailsController],
  providers: [EmailSendProcessor, sesSendDriverProvider],
})
export class EmailsModule {}

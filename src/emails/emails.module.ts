import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ApiKeysModule } from '../api-keys';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import { EmailSendProcessor } from './email-send.processor';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';
import { sesSendDriverProvider } from './ses/ses-send-driver.factory';

/**
 * Pipeline d'envoi : acceptation (`POST /v1/emails`), file BullMQ et
 * worker SES. Distinct d'`EmailsLogModule`, qui ne fait que lire.
 */
@Module({
  imports: [
    ApiKeysModule,
    BullModule.registerQueue({ name: EMAIL_SEND_QUEUE }),
  ],
  controllers: [EmailsController],
  providers: [EmailsService, EmailSendProcessor, sesSendDriverProvider],
})
export class EmailsModule {}

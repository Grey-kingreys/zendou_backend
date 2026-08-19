import { Module } from '@nestjs/common';
import { SmtpRelayModule } from '../smtp/smtp-relay.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  // `SmtpRelayModule` exporte `SmtpServerService` (B6/S10) : c'est lui qui
  // porte l'état d'écoute interrogeable par `checkSmtp()`. Le module reste
  // inerte par défaut (`SMTP_RELAY_ENABLED`), l'importer ici n'ouvre rien.
  imports: [SmtpRelayModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}

import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { EmailsCoreModule } from '../emails/emails-core.module';
import { SMTP_CERT_ALERT_REDIS } from './smtp-cert-alert.constants';
import {
  SMTP_CERT_ALERT_CLOCK,
  SMTP_CERT_INSPECTOR,
  inspectSmtpCertificate,
} from './smtp-cert-alert.inspector';
import {
  BullSmtpCertAlertScheduler,
  SMTP_CERT_ALERT_SCHEDULER,
} from './smtp-cert-alert.scheduler';
import { SmtpCertAlertService } from './smtp-cert-alert.service';

/**
 * Surveillance de l'expiration du certificat TLS du relais SMTP (B6/H1).
 *
 * Module distinct de `SmtpRelayModule` : la surveillance n'a besoin ni du
 * serveur SMTP, ni du pipeline, ni de l'anti-abus — seulement d'un chemin de
 * fichier, d'une horloge et d'un moyen d'expédier un email. Elle survivrait
 * telle quelle au jour où le relais tournerait dans son propre processus.
 *
 * **Inerte par défaut**, comme le relais lui-même : c'est
 * `SmtpCertAlertService.onApplicationBootstrap` qui décide, à la lecture de
 * `SMTP_RELAY_ENABLED`, s'il faut surveiller quoi que ce soit. Le client Redis
 * est déclaré en `lazyConnect` — construit avec le module, il n'ouvre aucune
 * socket tant qu'aucune commande n'est exécutée, donc jamais quand le relais
 * est désactivé. Et la file BullMQ n'est pas déclarée ici du tout : elle est
 * créée par le planificateur, au moment où il démarre (voir
 * `smtp-cert-alert.scheduler.ts`).
 *
 * `EmailsCoreModule` — et non `EmailsModule` — donne accès à `sendSystem`
 * seul, sans contrôleur ni `ApiKeysModule` : le chemin système déjà éprouvé,
 * en processus, sans crédit débité ni impact sur la métrique de réputation.
 */
@Module({
  // `PrismaModule` et `ConfigModule` sont globaux : rien à importer d'autre.
  imports: [EmailsCoreModule],
  providers: [
    {
      provide: SMTP_CERT_ALERT_REDIS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis => {
        const logger = new Logger('SmtpCertAlertStore');
        const client = new Redis(configService.get<string>('REDIS_URL')!, {
          lazyConnect: true,
          // Une surveillance ne doit jamais faire tomber le service : en cas
          // de coupure Redis, le service journalise et alerte quand même
          // plutôt que d'attendre indéfiniment un marqueur.
          maxRetriesPerRequest: 2,
        });
        client.on('error', (error: Error) => {
          logger.error('Redis smtp-cert-alert store error', error);
        });
        return client;
      },
    },
    { provide: SMTP_CERT_INSPECTOR, useValue: inspectSmtpCertificate },
    { provide: SMTP_CERT_ALERT_CLOCK, useValue: () => new Date() },
    {
      provide: SMTP_CERT_ALERT_SCHEDULER,
      useClass: BullSmtpCertAlertScheduler,
    },
    SmtpCertAlertService,
  ],
})
export class SmtpCertAlertModule {}

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import { EmailsService } from './emails.service';

/**
 * `EmailsService` seul, avec sa file — sans contrôleur, donc sans
 * `ApiKeysModule`.
 *
 * Même motif que `RateLimitCoreModule` : `AuthModule` a besoin d'expédier des
 * emails système (confirmation d'adresse), mais importer `EmailsModule`
 * fermerait un cycle — `AuthModule → EmailsModule → ApiKeysModule →
 * AuthModule`. Ce module-ci ne dépend que de la file, il peut donc être
 * importé de partout.
 *
 * L'envoi système passe par ce service **en processus**, jamais par un appel
 * HTTP de l'API sur elle-même : même file BullMQ, même worker, même DKIM,
 * même liste de suppression, mais aucune dépendance réseau ni circulaire sur
 * le chemin critique de l'inscription.
 */
@Module({
  imports: [BullModule.registerQueue({ name: EMAIL_SEND_QUEUE })],
  providers: [EmailsService],
  exports: [EmailsService],
})
export class EmailsCoreModule {}

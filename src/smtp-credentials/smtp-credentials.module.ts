import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys';
import { AuthModule } from '../auth';
import { SmtpCredentialsController } from './smtp-credentials.controller';
import { SmtpCredentialsService } from './smtp-credentials.service';

/**
 * `ApiKeysModule` apporte `SecretHashingService` : les identifiants SMTP
 * partagent la mécanique de hachage des clés API (poivre compris), comme ils
 * partagent déjà `generateBase62Secret` et `hashApiKey`. Aucun cycle :
 * `ApiKeysModule` ignore tout des identifiants SMTP.
 */
@Module({
  imports: [AuthModule, ApiKeysModule],
  controllers: [SmtpCredentialsController],
  providers: [SmtpCredentialsService],
  exports: [SmtpCredentialsService],
})
export class SmtpCredentialsModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DomainsModule } from '../domains/domains.module';
import { AccountAnonymizationService } from './account-anonymization.service';

/**
 * Cycle de vie des comptes (ANON-1) : anonymisation sur demande
 * d'effacement, via la route admin.
 *
 * `DomainsModule` fournit la destruction des identités SES par le même driver
 * que la suppression d'un domaine ; `AuthModule` la révocation des sessions.
 */
@Module({
  // `PrismaModule` et `ConfigModule` sont globaux.
  imports: [AuthModule, DomainsModule],
  providers: [AccountAnonymizationService],
  exports: [AccountAnonymizationService],
})
export class AccountLifecycleModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DomainsModule } from '../domains/domains.module';
import { EmailsCoreModule } from '../emails/emails-core.module';
import { AccountAnonymizationService } from './account-anonymization.service';
import {
  ACCOUNT_INACTIVITY_SCHEDULER,
  BullAccountInactivityScheduler,
} from './account-inactivity.scheduler';
import {
  ACCOUNT_LIFECYCLE_CLOCK,
  AccountInactivityService,
} from './account-inactivity.service';

/**
 * Cycle de vie des comptes (ANON-1) : anonymisation (sur demande, via la
 * route admin, ou automatique) et traitement quotidien des comptes inactifs.
 *
 * `DomainsModule` fournit la destruction des identités SES par le même driver
 * que la suppression d'un domaine ; `EmailsCoreModule` le chemin d'envoi
 * système de l'avertissement ; `AuthModule` la révocation des sessions.
 */
@Module({
  // `PrismaModule` et `ConfigModule` sont globaux.
  imports: [AuthModule, DomainsModule, EmailsCoreModule],
  providers: [
    AccountAnonymizationService,
    AccountInactivityService,
    { provide: ACCOUNT_LIFECYCLE_CLOCK, useValue: () => new Date() },
    {
      provide: ACCOUNT_INACTIVITY_SCHEDULER,
      useClass: BullAccountInactivityScheduler,
    },
  ],
  exports: [AccountAnonymizationService],
})
export class AccountLifecycleModule {}

import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys';
import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { SessionOrApiKeyGuard } from '../common/session-or-api-key.guard';
import { AdminGuard } from './admin/admin.guard';
import { AdminBillingController } from './admin/admin-billing.controller';
import { AdminBillingService } from './admin/admin-billing.service';

/**
 * Crédits et facturation, y compris la revue admin des demandes de
 * recharge Mobile Money (activation manuelle — cahier §7.3).
 */
@Module({
  imports: [AuthModule, ApiKeysModule],
  controllers: [BillingController, AdminBillingController],
  providers: [
    BillingService,
    SessionOrApiKeyGuard,
    AdminGuard,
    AdminBillingService,
  ],
})
export class BillingModule {}

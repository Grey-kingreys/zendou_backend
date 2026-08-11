import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { AdminGuard } from './admin/admin.guard';
import { AdminBillingController } from './admin/admin-billing.controller';
import { AdminBillingService } from './admin/admin-billing.service';

/**
 * Crédits et facturation, y compris la revue admin des demandes de
 * recharge Mobile Money (activation manuelle — cahier §7.3).
 */
@Module({
  imports: [AuthModule],
  controllers: [BillingController, AdminBillingController],
  providers: [BillingService, AdminGuard, AdminBillingService],
})
export class BillingModule {}

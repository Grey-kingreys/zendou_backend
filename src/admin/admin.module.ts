import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../billing/admin/admin.guard';
import { AdminStatsController } from './admin-stats.controller';
import { AdminStatsService } from './admin-stats.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

/**
 * Administration des comptes clients (cahier §8) : suspension, réactivation
 * avec remise à zéro de réputation, quota, gestes commerciaux — chaque action
 * tracée dans `AdminAction`. Porte aussi les statistiques d'envoi de toute
 * la plateforme (B13, `AdminStatsController`).
 *
 * L'`AdminGuard` est celui de la revue des recharges : une seule définition
 * du rôle admin pour toute l'API.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminUsersController, AdminStatsController],
  providers: [AdminGuard, AdminUsersService, AdminStatsService],
})
export class AdminModule {}

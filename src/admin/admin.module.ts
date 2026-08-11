import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../billing/admin/admin.guard';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

/**
 * Administration des comptes clients (cahier §8) : suspension, réactivation
 * avec remise à zéro de réputation, quota, gestes commerciaux — chaque action
 * tracée dans `AdminAction`.
 *
 * L'`AdminGuard` est celui de la revue des recharges : une seule définition
 * du rôle admin pour toute l'API.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminUsersController],
  providers: [AdminGuard, AdminUsersService],
})
export class AdminModule {}

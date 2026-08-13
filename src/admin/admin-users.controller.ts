import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth';
import type { AuthUser } from '../auth';
import { AdminGuard } from '../billing/admin/admin.guard';
import { AdminUsersService } from './admin-users.service';
import { GrantCreditsDto } from './dto/grant-credits.dto';
import { ReactivateUserDto } from './dto/reactivate-user.dto';
import { SuspendUserDto } from './dto/suspend-user.dto';
import { UpdateQuotaDto } from './dto/update-quota.dto';
import type {
  AdminCreditResult,
  AdminQuotaResult,
  AdminUserActionResult,
  AdminUserDeleteResult,
  AdminUserDetail,
  PaginatedAdminUsers,
  RawAdminUsersQuery,
} from './admin.types';

/**
 * Administration des comptes clients. Réutilise l'`AdminGuard` de la revue
 * des recharges : un seul garde pour toute la surface admin (401 si la
 * session manque, 403 si le rôle n'est pas ADMIN).
 */
@Controller('admin/users')
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  list(@Query() query: RawAdminUsersQuery): Promise<PaginatedAdminUsers> {
    return this.adminUsersService.list(query);
  }

  @Get(':id')
  detail(@Param('id') id: string): Promise<AdminUserDetail> {
    return this.adminUsersService.detail(id);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Param('id') id: string,
    @Body() dto: SuspendUserDto,
    @CurrentUser() admin: AuthUser,
  ): Promise<AdminUserActionResult> {
    return this.adminUsersService.suspend(admin.id, id, dto);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(
    @Param('id') id: string,
    @Body() dto: ReactivateUserDto,
    @CurrentUser() admin: AuthUser,
  ): Promise<AdminUserActionResult> {
    return this.adminUsersService.reactivate(admin.id, id, dto);
  }

  @Patch(':id/quota')
  quota(
    @Param('id') id: string,
    @Body() dto: UpdateQuotaDto,
    @CurrentUser() admin: AuthUser,
  ): Promise<AdminQuotaResult> {
    return this.adminUsersService.updateQuota(admin.id, id, dto);
  }

  @Post(':id/credits')
  @HttpCode(HttpStatus.OK)
  credits(
    @Param('id') id: string,
    @Body() dto: GrantCreditsDto,
    @CurrentUser() admin: AuthUser,
  ): Promise<AdminCreditResult> {
    return this.adminUsersService.grantCredits(admin.id, id, dto);
  }

  /**
   * Suppression réelle du compte. `AdminUsersService.deleteUser` refuse en
   * 409 tout compte qui possède encore des dépendances (domaines, clés API,
   * emails, mouvements de crédit, demandes de recharge, ou des actions
   * d'administration qu'il a lui-même effectuées) : cette route ne peut
   * donc jamais réussir sur un vrai client actif.
   */
  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() admin: AuthUser,
  ): Promise<AdminUserDeleteResult> {
    return this.adminUsersService.deleteUser(admin.id, id);
  }
}

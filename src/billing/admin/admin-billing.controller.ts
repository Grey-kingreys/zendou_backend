import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth';
import type { AuthUser } from '../../auth';
import { AdminGuard } from './admin.guard';
import { AdminBillingService } from './admin-billing.service';
import { RejectTopUpRequestDto } from './dto/reject-topup-request.dto';
import type {
  AdminTopUpRequestItem,
  AdminTopUpRequestReviewResult,
  RawAdminTopUpRequestsQuery,
} from './admin.types';

/**
 * Revue admin des demandes de recharge Mobile Money — fallback d'activation
 * manuelle (cahier §7.3).
 */
@Controller('admin/topup-requests')
@UseGuards(AdminGuard)
export class AdminBillingController {
  constructor(private readonly adminBillingService: AdminBillingService) {}

  @Get()
  list(
    @Query() query: RawAdminTopUpRequestsQuery,
  ): Promise<AdminTopUpRequestItem[]> {
    return this.adminBillingService.listTopUpRequests(query);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id') id: string,
    @CurrentUser() admin: AuthUser,
  ): Promise<AdminTopUpRequestReviewResult> {
    return this.adminBillingService.approve(id, admin.id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id') id: string,
    @Body() dto: RejectTopUpRequestDto,
    @CurrentUser() admin: AuthUser,
  ): Promise<AdminTopUpRequestReviewResult> {
    return this.adminBillingService.reject(id, admin.id, dto);
  }
}

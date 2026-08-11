import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, SessionAuthGuard } from '../auth';
import type { AuthUser } from '../auth';
import { BillingService } from './billing.service';
import { CreateTopUpRequestDto } from './dto/create-topup-request.dto';
import type { CreditPack } from './packs';
import type {
  BalanceSummary,
  PaginatedCreditEntries,
  RawEntriesListQuery,
  TopUpRequestItem,
} from './billing.types';

/**
 * Crédits et facturation — scopé à l'utilisateur courant.
 */
@Controller('billing')
@UseGuards(SessionAuthGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('balance')
  getBalance(@CurrentUser() user: AuthUser): Promise<BalanceSummary> {
    return this.billingService.getBalance(user.id);
  }

  @Get('entries')
  listEntries(
    @Query() query: RawEntriesListQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedCreditEntries> {
    return this.billingService.listEntries(user.id, query);
  }

  @Get('packs')
  listPacks(): CreditPack[] {
    return this.billingService.listPacks();
  }

  @Post('topup-requests')
  @HttpCode(HttpStatus.CREATED)
  createTopUpRequest(
    @Body() dto: CreateTopUpRequestDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TopUpRequestItem> {
    return this.billingService.createTopUpRequest(user.id, dto);
  }

  @Get('topup-requests')
  listTopUpRequests(
    @CurrentUser() user: AuthUser,
  ): Promise<TopUpRequestItem[]> {
    return this.billingService.listTopUpRequests(user.id);
  }
}

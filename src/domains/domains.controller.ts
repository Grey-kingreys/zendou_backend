import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, SessionAuthGuard } from '../auth';
import type { AuthUser } from '../auth';
import { RATE_LIMIT_POLICY } from '../rate-limit/rate-limit.constants';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { DomainsService } from './domains.service';
import type {
  DomainCheckResult,
  DomainDetail,
  DomainSummary,
} from './domains.types';
import { CreateDomainDto } from './dto/create-domain.dto';

@Controller('domains')
@UseGuards(SessionAuthGuard)
export class DomainsController {
  constructor(private readonly domainsService: DomainsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateDomainDto,
  ): Promise<DomainDetail> {
    return this.domainsService.create(user.id, dto.name);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  list(@CurrentUser() user: AuthUser): Promise<DomainSummary[]> {
    return this.domainsService.list(user.id);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<DomainDetail> {
    return this.domainsService.findOne(user.id, id);
  }

  // Chaque appel tape l'API AWS : plafond serré, et compté par utilisateur
  // pour ne pas pénaliser les autres clients derrière la même IP.
  @Post(':id/check')
  @RateLimit(RATE_LIMIT_POLICY.DOMAIN_CHECK)
  @HttpCode(HttpStatus.OK)
  check(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<DomainCheckResult> {
    return this.domainsService.check(user.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.domainsService.remove(user.id, id);
  }
}

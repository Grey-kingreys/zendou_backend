import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { ApiKeyAuthenticatedRequest } from '../api-keys';
import { CurrentUser } from '../auth';
import type { AuthUser } from '../auth';
import {
  AllowApiKeyRead,
  SessionOrApiKeyGuard,
} from '../common/session-or-api-key.guard';
import { RATE_LIMIT_POLICY } from '../rate-limit/rate-limit.constants';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import type { DomainDnsCheckResult } from './dns-check';
import { DomainsService } from './domains.service';
import type {
  DomainCheckResult,
  DomainDetail,
  DomainRemoveResult,
  DomainSummary,
  DomainUsage,
} from './domains.types';
import { CreateDomainDto } from './dto/create-domain.dto';

/**
 * Domaines du compte. Session seulement, sauf `GET /` et `GET /:id` qui
 * acceptent aussi une clé API avec la permission de lecture
 * (`AllowApiKeyRead`), dans la portée par domaine de la clé.
 */
@Controller('domains')
@UseGuards(SessionOrApiKeyGuard)
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
  @AllowApiKeyRead()
  @HttpCode(HttpStatus.OK)
  list(
    @CurrentUser() user: AuthUser,
    @Req() request: ApiKeyAuthenticatedRequest,
  ): Promise<DomainSummary[]> {
    return this.domainsService.list(user.id, request.apiKeyId);
  }

  @Get(':id')
  @AllowApiKeyRead()
  @HttpCode(HttpStatus.OK)
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Req() request: ApiKeyAuthenticatedRequest,
  ): Promise<DomainDetail> {
    return this.domainsService.findOne(user.id, id, request.apiKeyId);
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

  // Diagnostic DNS calculé côté Zendou (indépendant de SES) : plusieurs
  // résolutions DNS réseau par appel (3 CNAME DKIM + TXT SPF + TXT DMARC),
  // d'où la limitation de débit dédiée.
  @Get(':id/dns-check')
  @RateLimit(RATE_LIMIT_POLICY.DNS_CHECK)
  @HttpCode(HttpStatus.OK)
  dnsCheck(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<DomainDnsCheckResult> {
    return this.domainsService.dnsCheck(user.id, id);
  }

  // Aperçu d'impact avant suppression (B27) : clés API et identifiants SMTP
  // actifs liés au domaine. Lecture seule, session et propriétaire seulement.
  @Get(':id/usage')
  @HttpCode(HttpStatus.OK)
  usage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<DomainUsage> {
    return this.domainsService.usage(user.id, id);
  }

  // Rend la liste de ce que la suppression a révoqué (B27), d'où le 200 et
  // non plus un 204.
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<DomainRemoveResult> {
    return this.domainsService.remove(user.id, id);
  }
}

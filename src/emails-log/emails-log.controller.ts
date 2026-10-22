import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { ApiKeyAuthenticatedRequest } from '../api-keys';
import { CurrentUser } from '../auth';
import type { AuthUser } from '../auth';
import {
  AllowApiKeyRead,
  SessionOrApiKeyGuard,
} from '../common/session-or-api-key.guard';
import { EmailsLogService } from './emails-log.service';
import type {
  EmailDetail,
  PaginatedEmails,
  RawEmailsListQuery,
} from './emails-log.types';

/**
 * Journal des envois, lecture seule, scopé à l'utilisateur courant. Session,
 * ou clé API avec la permission de lecture (`AllowApiKeyRead`) filtrée par sa
 * portée par domaine.
 */
@Controller('emails')
@UseGuards(SessionOrApiKeyGuard)
export class EmailsLogController {
  constructor(private readonly emailsLogService: EmailsLogService) {}

  @Get()
  @AllowApiKeyRead()
  list(
    @Query() query: RawEmailsListQuery,
    @CurrentUser() user: AuthUser,
    @Req() request: ApiKeyAuthenticatedRequest,
  ): Promise<PaginatedEmails> {
    return this.emailsLogService.list(user.id, query, request.apiKeyId);
  }

  @Get(':publicId')
  @AllowApiKeyRead()
  detail(
    @Param('publicId') publicId: string,
    @CurrentUser() user: AuthUser,
    @Req() request: ApiKeyAuthenticatedRequest,
  ): Promise<EmailDetail> {
    return this.emailsLogService.detail(user.id, publicId, request.apiKeyId);
  }
}

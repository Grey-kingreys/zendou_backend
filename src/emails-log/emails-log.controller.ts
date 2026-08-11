import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, SessionAuthGuard } from '../auth';
import type { AuthUser } from '../auth';
import { EmailsLogService } from './emails-log.service';
import type {
  EmailDetail,
  PaginatedEmails,
  RawEmailsListQuery,
} from './emails-log.types';

/**
 * Journal des envois — lecture seule, scopé à l'utilisateur courant.
 */
@Controller('emails')
@UseGuards(SessionAuthGuard)
export class EmailsLogController {
  constructor(private readonly emailsLogService: EmailsLogService) {}

  @Get()
  list(
    @Query() query: RawEmailsListQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedEmails> {
    return this.emailsLogService.list(user.id, query);
  }

  @Get(':publicId')
  detail(
    @Param('publicId') publicId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<EmailDetail> {
    return this.emailsLogService.detail(user.id, publicId);
  }
}

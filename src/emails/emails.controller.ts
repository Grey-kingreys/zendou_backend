import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyAuthGuard } from '../api-keys';
import { CurrentUser } from '../auth';
import type { AuthUser } from '../auth';
import { SendEmailDto } from './dto/send-email.dto';
import { EmailsService } from './emails.service';
import type { SendEmailResponse } from './emails.types';

/**
 * Envoi transactionnel — authentifié par clé API, jamais par session :
 * c'est la surface appelée par les serveurs de nos clients.
 *
 * Cohabite avec `EmailsLogController`, qui sert les `GET /v1/emails`.
 */
@Controller('emails')
@UseGuards(ApiKeyAuthGuard)
export class EmailsController {
  constructor(private readonly emailsService: EmailsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  send(
    @CurrentUser() user: AuthUser,
    @Body() dto: SendEmailDto,
  ): Promise<SendEmailResponse> {
    return this.emailsService.send(user.id, dto);
  }
}

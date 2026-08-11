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
import { RATE_LIMIT_POLICY } from '../rate-limit/rate-limit.constants';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
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

  // Compté par clé API, pas par IP : les serveurs d'un même client sortent
  // souvent d'une IP partagée, et deux clients distincts ne doivent pas se
  // voler leur quota de rafale. Ce plafond ne protège que des rafales ; le
  // quota journalier et les crédits restent les limites métier.
  @Post()
  @RateLimit(RATE_LIMIT_POLICY.EMAIL_SEND)
  @HttpCode(HttpStatus.ACCEPTED)
  send(
    @CurrentUser() user: AuthUser,
    @Body() dto: SendEmailDto,
  ): Promise<SendEmailResponse> {
    return this.emailsService.send(user.id, dto);
  }
}

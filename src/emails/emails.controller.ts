import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyAuthGuard } from '../api-keys';
import { CurrentUser, EmailVerifiedGuard } from '../auth';
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
 *
 * `EmailVerifiedGuard` s'exécute après `ApiKeyAuthGuard` (l'ordre est celui de
 * la liste) : un compte dont l'adresse n'est pas confirmée est authentifié
 * normalement, puis refusé en 403. C'est la moitié de la fermeture ; l'autre
 * est sur la création de clé API, sans quoi il suffirait d'attendre d'avoir
 * une clé pour contourner celle-ci.
 */
@Controller('emails')
@UseGuards(ApiKeyAuthGuard, EmailVerifiedGuard)
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

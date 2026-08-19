import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, EmailVerifiedGuard, SessionAuthGuard } from '../auth';
import type { AuthUser } from '../auth';
import { SmtpCredentialsService } from './smtp-credentials.service';
import {
  CreateSmtpCredentialResponse,
  RotateSmtpCredentialResponse,
  SmtpCredentialSummary,
} from './smtp-credentials.types';
import { CreateSmtpCredentialDto } from './dto/create-smtp-credential.dto';

@Controller('smtp-credentials')
@UseGuards(SessionAuthGuard)
export class SmtpCredentialsController {
  constructor(
    private readonly smtpCredentialsService: SmtpCredentialsService,
  ) {}

  /**
   * Seule route du contrôleur fermée aux comptes non confirmés : créer un
   * identifiant SMTP, c'est obtenir le moyen d'envoyer. Lister, révoquer,
   * supprimer et régénérer restent ouverts — ce sont des gestes de reprise
   * en main, pas de nouvelles capacités d'envoi (même raisonnement que
   * `ApiKeysController`).
   */
  @Post()
  @UseGuards(EmailVerifiedGuard)
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSmtpCredentialDto,
  ): Promise<CreateSmtpCredentialResponse> {
    return this.smtpCredentialsService.create(user.id, dto);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  findAll(@CurrentUser() user: AuthUser): Promise<SmtpCredentialSummary[]> {
    return this.smtpCredentialsService.findAllForUser(user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.smtpCredentialsService.revoke(user.id, id);
  }

  /**
   * Suppression définitive, distincte de `DELETE /:id` (révocation) : ce
   * segment supplémentaire ne casse aucun appel existant sur `DELETE /:id`.
   * Réservée aux identifiants déjà révoqués.
   */
  @Delete(':id/purge')
  @HttpCode(HttpStatus.NO_CONTENT)
  async purge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.smtpCredentialsService.purge(user.id, id);
  }

  @Post(':id/rotate')
  @HttpCode(HttpStatus.OK)
  rotate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<RotateSmtpCredentialResponse> {
    return this.smtpCredentialsService.rotate(user.id, id);
  }
}

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
import { ApiKeysService } from './api-keys.service';
import {
  ApiKeySummary,
  CreateApiKeyResponse,
  RotateApiKeyResponse,
} from './api-keys.types';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@Controller('api-keys')
@UseGuards(SessionAuthGuard)
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  /**
   * Seule route du contrôleur fermée aux comptes non confirmés : créer une
   * clé, c'est obtenir le moyen d'envoyer. Lister, révoquer, supprimer et
   * régénérer restent ouverts — ce sont des gestes de reprise en main, pas de
   * nouvelles capacités d'envoi, et les interdire enfermerait un compte non
   * confirmé avec des clés qu'il ne pourrait plus révoquer.
   */
  @Post()
  @UseGuards(EmailVerifiedGuard)
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateApiKeyDto,
  ): Promise<CreateApiKeyResponse> {
    return this.apiKeysService.create(user.id, dto);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  findAll(@CurrentUser() user: AuthUser): Promise<ApiKeySummary[]> {
    return this.apiKeysService.findAllForUser(user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.apiKeysService.revoke(user.id, id);
  }

  /**
   * Suppression définitive, distincte de `DELETE /:id` (révocation) : ce
   * segment supplémentaire ne casse aucun appel existant sur `DELETE /:id`.
   * Réservée aux clés déjà révoquées.
   */
  @Delete(':id/purge')
  @HttpCode(HttpStatus.NO_CONTENT)
  async purge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.apiKeysService.purge(user.id, id);
  }

  @Post(':id/rotate')
  @HttpCode(HttpStatus.OK)
  rotate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<RotateApiKeyResponse> {
    return this.apiKeysService.rotate(user.id, id);
  }
}

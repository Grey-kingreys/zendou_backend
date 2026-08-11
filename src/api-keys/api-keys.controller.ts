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
import { CurrentUser, SessionAuthGuard } from '../auth';
import type { AuthUser } from '../auth';
import { ApiKeysService } from './api-keys.service';
import { ApiKeySummary, CreateApiKeyResponse } from './api-keys.types';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@Controller('api-keys')
@UseGuards(SessionAuthGuard)
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Post()
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
}

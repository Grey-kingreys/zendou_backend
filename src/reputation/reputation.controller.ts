import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, SessionAuthGuard } from '../auth';
import type { AuthUser } from '../auth';
import { ReputationService } from './reputation.service';
import type { ReputationOverview } from './reputation.types';

/**
 * Réputation du compte courant — lecture seule, alimente l'écran
 * « Alertes de réputation » du tableau de bord.
 */
@Controller('reputation')
@UseGuards(SessionAuthGuard)
export class ReputationController {
  constructor(private readonly reputationService: ReputationService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  overview(@CurrentUser() user: AuthUser): Promise<ReputationOverview> {
    return this.reputationService.overview(user.id);
  }
}

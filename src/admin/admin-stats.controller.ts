import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../billing/admin/admin.guard';
import { AdminStatsService } from './admin-stats.service';
import type { AdminEmailStats } from './admin-stats.types';

/**
 * Statistiques d'envoi de toute la plateforme (B13). Compteurs et
 * répartition par statut uniquement — délibérément **pas** de journal
 * paginé : exposer le détail par email (destinataire, objet) toutes-comptes
 * confondues serait une fuite de vie privée que le porteur n'a pas
 * tranchée. Un futur journal global devra être une décision distincte, pas
 * un ajout silencieux à ce lot.
 *
 * Réutilise l'`AdminGuard` de `AdminUsersController` : un seul garde pour
 * toute la surface admin (401 sans session, 403 hors rôle ADMIN).
 */
@Controller('admin/stats')
@UseGuards(AdminGuard)
export class AdminStatsController {
  constructor(private readonly adminStatsService: AdminStatsService) {}

  @Get('emails')
  emails(): Promise<AdminEmailStats> {
    return this.adminStatsService.emailStats();
  }
}

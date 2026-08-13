import { Injectable } from '@nestjs/common';
import { EmailStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AdminEmailStats,
  PlatformCounts,
  StatusBreakdown,
} from './admin-stats.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ordre d'affichage stable, indépendant de l'ordre de déclaration Prisma. */
const ALL_STATUSES = Object.values(EmailStatus);

type SystemGroup = { system: boolean; _count: { _all: number } };
type StatusGroup = { status: EmailStatus; _count: { _all: number } };

/**
 * Statistiques d'envoi de **toute la plateforme** (B13) : compteurs
 * uniquement, pas de journal — voir `AdminStatsController` pour le motif de
 * vie privée. Deux chiffres jamais confondus : le total incluant les emails
 * système (ce qui consomme réellement le quota SES) et la part système
 * isolée, parce que les KPI existants (`AdminUsersService`) comptent
 * l'inverse (`system: false`, « ce que le client a envoyé ») et ne doivent
 * pas être redéfinis par ce lot.
 */
@Injectable()
export class AdminStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async emailStats(): Promise<AdminEmailStats> {
    const now = new Date();

    // Fenêtres temporelles en UTC. La Guinée est à UTC+0 toute l'année (pas
    // d'heure d'été) : minuit UTC coïncide avec minuit à Conakry. C'est une
    // coïncidence commode propre à ce pays, pas une propriété universelle du
    // calcul — un futur lecteur qui réutiliserait ce code pour un fuseau
    // différent devrait convertir explicitement avant de tronquer à minuit.
    const startOfTodayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const last7dStart = new Date(now.getTime() - 7 * DAY_MS);
    const last30dStart = new Date(now.getTime() - 30 * DAY_MS);

    // Cinq requêtes groupées, en parallèle : le coût ne dépend ni du nombre
    // de comptes ni du nombre d'emails. Pas de `COUNT(*)` répété par
    // fenêtre — un seul `groupBy(['system'])` par fenêtre donne à la fois le
    // total et la part système.
    const [
      totalBySystem,
      todayBySystem,
      last7dBySystem,
      last30dBySystem,
      statusGroups,
    ] = await Promise.all([
      this.prisma.email.groupBy({
        by: ['system'],
        _count: { _all: true },
      }),
      this.prisma.email.groupBy({
        by: ['system'],
        where: { queuedAt: { gte: startOfTodayUtc } },
        _count: { _all: true },
      }),
      this.prisma.email.groupBy({
        by: ['system'],
        where: { queuedAt: { gte: last7dStart } },
        _count: { _all: true },
      }),
      this.prisma.email.groupBy({
        by: ['system'],
        where: { queuedAt: { gte: last30dStart } },
        _count: { _all: true },
      }),
      // Répartition par statut sur toute l'histoire, système inclus : pas
      // de filtre `queuedAt`, sert par `@@index([status])` déjà en place.
      this.prisma.email.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    return {
      total: this.toPlatformCounts(totalBySystem),
      today: this.toPlatformCounts(todayBySystem),
      last7d: this.toPlatformCounts(last7dBySystem),
      last30d: this.toPlatformCounts(last30dBySystem),
      byStatus: this.toStatusBreakdown(statusGroups),
      generatedAt: now,
    };
  }

  /**
   * `all` n'est jamais lu ni recalculé séparément : c'est la somme de
   * `system` et `client` telle qu'assemblée ici, donc l'invariant
   * `all = system + client` est garanti par construction plutôt que vérifié
   * après coup.
   */
  private toPlatformCounts(rows: SystemGroup[]): PlatformCounts {
    const system = rows.find((row) => row.system)?._count._all ?? 0;
    const client = rows.find((row) => !row.system)?._count._all ?? 0;

    return { all: system + client, system, client };
  }

  /** Toutes les valeurs de l'enum, y compris celles absentes des lignes. */
  private toStatusBreakdown(rows: StatusGroup[]): StatusBreakdown {
    const counts = new Map(rows.map((row) => [row.status, row._count._all]));

    return Object.fromEntries(
      ALL_STATUSES.map((status) => [status, counts.get(status) ?? 0]),
    ) as StatusBreakdown;
  }
}

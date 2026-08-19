import type { EmailChannel, EmailStatus } from '@prisma/client';

/**
 * Compteur ventilé système / client. `all` est toujours la somme des deux —
 * jamais un troisième chiffre calculé indépendamment, pour ne jamais pouvoir
 * diverger d'eux (voir `AdminStatsService.toPlatformCounts`).
 */
export interface PlatformCounts {
  all: number;
  system: number;
  client: number;
}

/**
 * Répartition du total **plateforme** (système inclus) par statut, sur toute
 * l'histoire. Toutes les valeurs de l'enum `EmailStatus` sont présentes,
 * même à zéro : un statut absent forcerait le frontend à deviner.
 */
export type StatusBreakdown = Record<EmailStatus, number>;

/**
 * Répartition du total **plateforme** (système inclus) par canal d'entrée
 * (B6), sur toute l'histoire — même périmètre que `byStatus` : pas de
 * fenêtre `queuedAt`, toutes les valeurs de l'enum `EmailChannel` présentes
 * même à zéro. Invariant : `API + SMTP === total.all`.
 */
export type ChannelBreakdown = Record<EmailChannel, number>;

/** Réponse de `GET /v1/admin/stats/emails`. */
export interface AdminEmailStats {
  total: PlatformCounts;
  today: PlatformCounts;
  last7d: PlatformCounts;
  last30d: PlatformCounts;
  byStatus: StatusBreakdown;
  byChannel: ChannelBreakdown;
  generatedAt: Date;
}

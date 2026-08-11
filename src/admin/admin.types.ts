import type {
  AdminActionType,
  Prisma,
  UserRole,
  UserStatus,
} from '@prisma/client';

/**
 * Query brute reçue par le contrôleur (tout arrive en string depuis Express —
 * le `ValidationPipe` global n'a pas `transform: true`). Le parsing est fait
 * explicitement dans `AdminUsersService`, à l'image d'`EmailsLogService`.
 */
export interface RawAdminUsersQuery {
  page?: string;
  limit?: string;
  status?: string;
  role?: string;
  q?: string;
}

/** Colonnes du compte lues telles quelles en base pour la liste. */
export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  company: string | null;
  role: UserRole;
  status: UserStatus;
  dailySendLimit: number;
  createdAt: Date;
  suspendedAt: Date | null;
}

/** Ligne de la liste admin : le compte, son solde et son volume récent. */
export interface AdminUserListItem extends AdminUserRow {
  /** Somme du ledger `CreditEntry`, jamais stockée. */
  creditBalance: number;
  /** Envois réellement partis sur les 30 derniers jours. */
  emailsSent30d: number;
}

/** Action d'audit telle qu'exposée dans le détail d'un compte. */
export interface AdminActionItem {
  id: string;
  type: AdminActionType;
  reason: string | null;
  details: Prisma.JsonValue | null;
  createdAt: Date;
  admin: { id: string; email: string; name: string };
}

/** Détail d'un compte : la ligne de liste, enrichie du contexte du dossier. */
export interface AdminUserDetail extends AdminUserListItem {
  suspensionReason: string | null;
  reputationResetAt: Date | null;
  declaredUsage: string | null;
  domainsCount: number;
  verifiedDomainsCount: number;
  activeApiKeysCount: number;
  recentActions: AdminActionItem[];
}

export interface PaginatedAdminUsers {
  items: AdminUserListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** État d'un compte après une suspension ou une réactivation. */
export interface AdminUserActionResultState {
  id: string;
  status: UserStatus;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  reputationResetAt: Date | null;
}

/** Réponse commune des actions qui changent l'état d'un compte. */
export interface AdminUserActionResult extends AdminUserActionResultState {
  /** Identifiant de la ligne d'audit écrite par l'action. */
  actionId: string;
}

export interface AdminQuotaResult {
  id: string;
  dailySendLimit: number;
  previousDailySendLimit: number;
  actionId: string;
}

export interface AdminCreditResult {
  id: string;
  delta: number;
  /** Solde du ledger après le mouvement. */
  creditBalance: number;
  actionId: string;
}

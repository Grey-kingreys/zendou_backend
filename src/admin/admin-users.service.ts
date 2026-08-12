import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminActionType,
  DomainStatus,
  Prisma,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  REPUTATION_WINDOW_DAYS,
  SENT_EMAIL_STATUSES,
} from '../reputation/reputation.constants';
import {
  CREDIT_REASON_ADMIN_GRANT,
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  RECENT_ACTIONS_LIMIT,
  SELF_CREDIT_MESSAGE,
  SELF_SUSPEND_MESSAGE,
  USER_ALREADY_ACTIVE_MESSAGE,
  USER_ALREADY_SUSPENDED_MESSAGE,
  USER_NOT_FOUND_MESSAGE,
} from './admin.constants';
import type {
  AdminCreditResult,
  AdminQuotaResult,
  AdminUserActionResult,
  AdminUserDetail,
  AdminUserRow,
  AdminUserActionResultState,
  PaginatedAdminUsers,
  RawAdminUsersQuery,
} from './admin.types';
import type { GrantCreditsDto } from './dto/grant-credits.dto';
import type { ReactivateUserDto } from './dto/reactivate-user.dto';
import type { SuspendUserDto } from './dto/suspend-user.dto';
import type { UpdateQuotaDto } from './dto/update-quota.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

const USER_ROW_SELECT = {
  id: true,
  email: true,
  name: true,
  company: true,
  role: true,
  status: true,
  dailySendLimit: true,
  createdAt: true,
  suspendedAt: true,
} satisfies Record<keyof AdminUserRow, true>;

/** Colonnes renvoyées par les actions qui changent l'état d'un compte. */
const USER_STATE_SELECT = {
  id: true,
  status: true,
  suspendedAt: true,
  suspensionReason: true,
  reputationResetAt: true,
} satisfies Record<keyof AdminUserActionResultState, true>;

const ADMIN_ACTION_SELECT = {
  id: true,
  type: true,
  reason: true,
  details: true,
  createdAt: true,
  admin: { select: { id: true, email: true, name: true } },
};

/**
 * Administration des comptes clients : consultation, suspension,
 * **réactivation**, ajustement de quota et gestes commerciaux.
 *
 * Toute action qui change l'état d'un compte écrit une ligne `AdminAction`
 * dans la **même transaction** que l'écriture qu'elle décrit : le journal ne
 * peut ni mentir par omission (action sans trace) ni par excès (trace sans
 * action).
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liste paginée des comptes.
   *
   * Soldes et volumes sont agrégés en **deux requêtes groupées** couvrant
   * toute la page, pas une paire par utilisateur : une page de 25 comptes
   * coûte 4 requêtes, comme une page de 3.
   */
  async list(query: RawAdminUsersQuery): Promise<PaginatedAdminUsers> {
    const page = this.parsePositiveInt(query.page, 'page', DEFAULT_PAGE);
    const limit = this.parsePositiveInt(
      query.limit,
      'limit',
      DEFAULT_LIMIT,
      MAX_LIMIT,
    );

    const where = this.buildWhere(query);
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: USER_ROW_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    const ids = rows.map((row) => row.id);
    const [balances, sends] = await Promise.all([
      this.prisma.creditEntry.groupBy({
        by: ['userId'],
        where: { userId: { in: ids } },
        _sum: { delta: true },
      }),
      // `system: false` : « emails envoyés » veut dire envoyés *par le
      // client*. Compter les emails que Zendou lui adresse gonflerait le KPI
      // d'exactement un envoi par compte créé.
      this.prisma.email.groupBy({
        by: ['userId'],
        where: {
          userId: { in: ids },
          system: false,
          queuedAt: { gte: this.windowStart() },
          status: { in: [...SENT_EMAIL_STATUSES] },
        },
        _count: { _all: true },
      }),
    ]);

    const balanceOf = new Map(
      balances.map((row) => [row.userId, row._sum.delta ?? 0]),
    );
    const sendsOf = new Map(sends.map((row) => [row.userId, row._count._all]));

    return {
      items: rows.map((row) => ({
        ...row,
        creditBalance: balanceOf.get(row.id) ?? 0,
        emailsSent30d: sendsOf.get(row.id) ?? 0,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** Dossier complet d'un compte, y compris ses dernières actions d'audit. */
  async detail(id: string): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...USER_ROW_SELECT,
        suspensionReason: true,
        reputationResetAt: true,
        declaredUsage: true,
      },
    });

    if (!user) {
      throw new NotFoundException(USER_NOT_FOUND_MESSAGE);
    }

    const [balance, emailsSent30d, domains, activeApiKeysCount, recentActions] =
      await Promise.all([
        this.prisma.creditEntry.aggregate({
          where: { userId: id },
          _sum: { delta: true },
        }),
        // Même exclusion que dans `list` : ce compteur est celui des envois
        // du client, pas des emails système qui lui sont adressés.
        this.prisma.email.count({
          where: {
            userId: id,
            system: false,
            queuedAt: { gte: this.windowStart() },
            status: { in: [...SENT_EMAIL_STATUSES] },
          },
        }),
        this.prisma.domain.groupBy({
          by: ['status'],
          where: { userId: id },
          _count: { _all: true },
        }),
        this.prisma.apiKey.count({ where: { userId: id, revokedAt: null } }),
        this.prisma.adminAction.findMany({
          where: { targetUserId: id },
          select: ADMIN_ACTION_SELECT,
          orderBy: { createdAt: 'desc' },
          take: RECENT_ACTIONS_LIMIT,
        }),
      ]);

    const domainsCount = domains.reduce(
      (total, row) => total + row._count._all,
      0,
    );
    const verifiedDomainsCount =
      domains.find((row) => row.status === DomainStatus.VERIFIED)?._count
        ._all ?? 0;

    return {
      ...user,
      creditBalance: balance._sum.delta ?? 0,
      emailsSent30d,
      domainsCount,
      verifiedDomainsCount,
      activeApiKeysCount,
      recentActions,
    };
  }

  /** Coupe les envois du compte. 409 si la suspension est déjà en place. */
  async suspend(
    adminId: string,
    id: string,
    dto: SuspendUserDto,
  ): Promise<AdminUserActionResult> {
    this.refuseSelf(adminId, id, SELF_SUSPEND_MESSAGE);

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id },
        select: { id: true, status: true },
      });

      if (!current) {
        throw new NotFoundException(USER_NOT_FOUND_MESSAGE);
      }

      if (current.status === UserStatus.SUSPENDED) {
        throw new ConflictException(USER_ALREADY_SUSPENDED_MESSAGE);
      }

      const updated = await tx.user.update({
        where: { id },
        data: {
          status: UserStatus.SUSPENDED,
          suspendedAt: new Date(),
          suspensionReason: dto.reason,
        },
        select: USER_STATE_SELECT,
      });

      const action = await tx.adminAction.create({
        data: {
          adminId,
          targetUserId: id,
          type: AdminActionType.SUSPEND_USER,
          reason: dto.reason,
        },
        select: { id: true },
      });

      return { ...updated, actionId: action.id };
    });
  }

  /**
   * Rouvre le compte **et solde son passé de réputation** : sans
   * `reputationResetAt`, le compte réactivé traînerait les rebonds qui l'ont
   * fait suspendre et `ReputationService.evaluate` le re-suspendrait au
   * premier événement suivant. La réactivation serait purement décorative.
   */
  async reactivate(
    adminId: string,
    id: string,
    dto: ReactivateUserDto,
  ): Promise<AdminUserActionResult> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id },
        select: { id: true, status: true, suspensionReason: true },
      });

      if (!current) {
        throw new NotFoundException(USER_NOT_FOUND_MESSAGE);
      }

      if (current.status === UserStatus.ACTIVE) {
        throw new ConflictException(USER_ALREADY_ACTIVE_MESSAGE);
      }

      const reputationResetAt = new Date();

      const updated = await tx.user.update({
        where: { id },
        data: {
          status: UserStatus.ACTIVE,
          reputationResetAt,
          suspendedAt: null,
          suspensionReason: null,
        },
        select: USER_STATE_SELECT,
      });

      const action = await tx.adminAction.create({
        data: {
          adminId,
          targetUserId: id,
          type: AdminActionType.REACTIVATE_USER,
          reason: dto.reason ?? null,
          details: {
            reputationResetAt: reputationResetAt.toISOString(),
            previousSuspensionReason: current.suspensionReason,
          },
        },
        select: { id: true },
      });

      return { ...updated, actionId: action.id };
    });
  }

  /** Ajuste le quota journalier à la main, hors montée en charge automatique. */
  async updateQuota(
    adminId: string,
    id: string,
    dto: UpdateQuotaDto,
  ): Promise<AdminQuotaResult> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id },
        select: { id: true, dailySendLimit: true },
      });

      if (!current) {
        throw new NotFoundException(USER_NOT_FOUND_MESSAGE);
      }

      const updated = await tx.user.update({
        where: { id },
        data: { dailySendLimit: dto.dailySendLimit },
        select: { id: true, dailySendLimit: true },
      });

      const action = await tx.adminAction.create({
        data: {
          adminId,
          targetUserId: id,
          type: AdminActionType.ADJUST_QUOTA,
          details: {
            previousDailySendLimit: current.dailySendLimit,
            dailySendLimit: updated.dailySendLimit,
          },
        },
        select: { id: true },
      });

      return {
        id: updated.id,
        dailySendLimit: updated.dailySendLimit,
        previousDailySendLimit: current.dailySendLimit,
        actionId: action.id,
      };
    });
  }

  /**
   * Geste commercial (ou reprise d'un geste accordé à tort, delta négatif).
   * Le mouvement de ledger porte l'identifiant de la ligne d'audit en
   * `reference` : depuis n'importe quelle ligne du relevé du client, on
   * remonte à l'admin qui l'a décidée et au motif qu'il a donné.
   */
  async grantCredits(
    adminId: string,
    id: string,
    dto: GrantCreditsDto,
  ): Promise<AdminCreditResult> {
    this.refuseSelf(adminId, id, SELF_CREDIT_MESSAGE);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!user) {
        throw new NotFoundException(USER_NOT_FOUND_MESSAGE);
      }

      const action = await tx.adminAction.create({
        data: {
          adminId,
          targetUserId: id,
          type: AdminActionType.GRANT_CREDITS,
          reason: dto.reason,
          details: { delta: dto.delta },
        },
        select: { id: true },
      });

      await tx.creditEntry.create({
        data: {
          userId: id,
          delta: dto.delta,
          reason: CREDIT_REASON_ADMIN_GRANT,
          reference: action.id,
        },
      });

      const balance = await tx.creditEntry.aggregate({
        where: { userId: id },
        _sum: { delta: true },
      });

      return {
        id,
        delta: dto.delta,
        creditBalance: balance._sum.delta ?? 0,
        actionId: action.id,
      };
    });
  }

  /**
   * Un admin ne s'administre pas lui-même : se suspendre coupe son propre
   * accès (plus personne pour revenir en arrière si c'est le seul admin), et
   * se créditer est un conflit d'intérêts que le journal d'audit ne corrige
   * pas — il ne fait que l'enregistrer.
   */
  private refuseSelf(adminId: string, targetId: string, message: string): void {
    if (adminId === targetId) {
      throw new BadRequestException(message);
    }
  }

  private windowStart(): Date {
    return new Date(Date.now() - REPUTATION_WINDOW_DAYS * DAY_MS);
  }

  private buildWhere(query: RawAdminUsersQuery): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = {};

    const status = this.parseEnum(query.status, UserStatus, 'status');
    if (status) {
      where.status = status;
    }

    const role = this.parseEnum(query.role, UserRole, 'role');
    if (role) {
      where.role = role;
    }

    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { email: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  private parseEnum<T extends Record<string, string>>(
    raw: string | undefined,
    values: T,
    field: string,
  ): T[keyof T] | undefined {
    if (raw === undefined || raw === '') {
      return undefined;
    }

    if (!Object.values(values).includes(raw)) {
      throw new BadRequestException(`${field} inconnu : ${raw}`);
    }

    return raw as T[keyof T];
  }

  private parsePositiveInt(
    raw: string | undefined,
    field: string,
    fallback: number,
    max?: number,
  ): number {
    if (raw === undefined || raw === '') {
      return fallback;
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new BadRequestException(
        `${field} doit être un entier supérieur ou égal à 1`,
      );
    }

    if (max !== undefined && value > max) {
      throw new BadRequestException(
        `${field} doit être inférieur ou égal à ${max}`,
      );
    }

    return value;
  }
}

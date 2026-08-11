import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EmailStatus, UserStatus } from '@prisma/client';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_DAILY_SEND_LIMIT,
  MAX_BOUNCE_RATE,
  MAX_COMPLAINT_RATE,
  MIN_VOLUME_FOR_SANCTION,
  RECOMPUTE_LIMIT_KEY_PREFIX,
  RECOMPUTE_LIMIT_TTL_SECONDS,
  REPUTATION_REDIS,
  REPUTATION_WINDOW_DAYS,
  SEND_LIMIT_TIERS,
  SENT_EMAIL_STATUSES,
  WARNING_THRESHOLD_RATIO,
} from './reputation.constants';
import type {
  ReputationMetrics,
  ReputationOverview,
  ReputationUser,
  ReputationVerdict,
} from './reputation.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Colonnes chargées pour évaluer un client et calculer son palier. */
const USER_SELECT = {
  id: true,
  email: true,
  status: true,
  dailySendLimit: true,
  createdAt: true,
} satisfies Record<keyof ReputationUser, true>;

/**
 * Protection de la réputation d'envoi — mitigation du risque n°1 du produit :
 * les taux de rebond et de plainte sont mesurés par AWS **au niveau du compte
 * SES entier**, donc un seul client abusif peut faire suspendre Zendou et
 * couper tous les autres clients. On suspend le client fautif nous-mêmes,
 * avant qu'AWS ne nous suspende.
 */
@Injectable()
export class ReputationService {
  private readonly logger = new Logger(ReputationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REPUTATION_REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Calcule les taux du client sur la fenêtre glissante et applique la
   * sanction correspondante (suspension sur `SUSPEND`, log sur `WARNING`).
   * Appelée après chaque rebond et chaque plainte reçus de SNS.
   */
  async evaluate(userId: string): Promise<ReputationMetrics> {
    return this.evaluateUser(await this.loadUser(userId));
  }

  /** Métriques + état du compte, pour l'écran « Alertes de réputation ». */
  async overview(userId: string): Promise<ReputationOverview> {
    const user = await this.loadUser(userId);
    const metrics = await this.evaluateUser(user);

    return {
      ...metrics,
      dailySendLimit: user.dailySendLimit,
      status: user.status,
    };
  }

  /**
   * Montée en charge progressive (cahier §5.2) : élève la limite journalière
   * quand le compte a fait ses preuves en ancienneté **et** en volume, et
   * seulement si sa réputation est saine. La limite ne redescend jamais
   * d'elle-même — seule une suspension coupe les envois.
   *
   * Appelée de façon opportuniste après chaque envoi réussi, donc bornée à
   * un recalcul par heure et par client.
   *
   * @returns la limite en vigueur, ou `null` si le recalcul a été throttlé.
   */
  async recomputeDailyLimit(userId: string): Promise<number | null> {
    if (!(await this.acquireRecomputeSlot(userId))) {
      return null;
    }

    const user = await this.loadUser(userId);
    const metrics = await this.evaluateUser(user);

    // Une réputation dégradée gèle le palier : on n'augmente jamais la
    // capacité de nuisance d'un compte déjà sur la pente glissante.
    if (metrics.verdict !== 'OK') {
      this.logger.log(
        `Élévation de quota gelée pour ${user.email} (verdict ${metrics.verdict})`,
      );
      return user.dailySendLimit;
    }

    const lifetimeSends = await this.prisma.email.count({
      where: { userId: user.id, status: { in: [...SENT_EMAIL_STATUSES] } },
    });

    const target = resolveDailyLimit(ageInDays(user.createdAt), lifetimeSends);

    if (target <= user.dailySendLimit) {
      return user.dailySendLimit;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { dailySendLimit: target },
    });

    this.logger.log(
      `Quota journalier relevé pour ${user.email} : ${user.dailySendLimit} → ${target} ` +
        `(ancienneté ${Math.floor(ageInDays(user.createdAt))} j, ${lifetimeSends} envois cumulés)`,
    );

    return target;
  }

  private async evaluateUser(user: ReputationUser): Promise<ReputationMetrics> {
    const since = new Date(Date.now() - REPUTATION_WINDOW_DAYS * DAY_MS);

    const rows = await this.prisma.email.groupBy({
      by: ['status'],
      where: {
        userId: user.id,
        queuedAt: { gte: since },
        status: { in: [...SENT_EMAIL_STATUSES] },
      },
      _count: { _all: true },
    });

    const countOf = (status: EmailStatus): number =>
      rows.find((row) => row.status === status)?._count._all ?? 0;

    const sent = rows.reduce((total, row) => total + row._count._all, 0);
    const bounces = countOf(EmailStatus.BOUNCED);
    const complaints = countOf(EmailStatus.COMPLAINED);
    const bounceRate = sent === 0 ? 0 : bounces / sent;
    const complaintRate = sent === 0 ? 0 : complaints / sent;

    const metrics: ReputationMetrics = {
      sent,
      bounces,
      complaints,
      bounceRate,
      complaintRate,
      verdict: resolveVerdict(sent, bounceRate, complaintRate),
    };

    if (metrics.verdict === 'SUSPEND') {
      await this.suspend(user, metrics);
    } else if (metrics.verdict === 'WARNING') {
      this.logger.warn(
        `Réputation dégradée pour ${user.email} (${user.id}) — ${describeMetrics(metrics)} ; ` +
          `seuils de suspension : rebonds ${formatRate(MAX_BOUNCE_RATE)}, plaintes ${formatRate(MAX_COMPLAINT_RATE)}`,
      );
    }

    return metrics;
  }

  /** Idempotent : un compte déjà suspendu n'est pas réécrit. */
  private async suspend(
    user: ReputationUser,
    metrics: ReputationMetrics,
  ): Promise<void> {
    if (user.status === UserStatus.SUSPENDED) {
      this.logger.warn(
        `Compte déjà suspendu ${user.email} (${user.id}) — ${describeMetrics(metrics)}`,
      );
      return;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { status: UserStatus.SUSPENDED },
    });

    // La ligne en mémoire doit refléter l'écriture : `overview` renvoie
    // l'état réel du compte, y compris quand il vient d'être suspendu.
    user.status = UserStatus.SUSPENDED;

    this.logger.error(
      `SUSPENSION AUTOMATIQUE — compte ${user.email} (${user.id}) suspendu pour réputation : ` +
        `${describeMetrics(metrics)} ; seuils : rebonds ${formatRate(MAX_BOUNCE_RATE)}, ` +
        `plaintes ${formatRate(MAX_COMPLAINT_RATE)}, volume minimum ${MIN_VOLUME_FOR_SANCTION}`,
    );
  }

  private async loadUser(userId: string): Promise<ReputationUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });

    if (!user) {
      throw new NotFoundException('Utilisateur introuvable');
    }

    return user;
  }

  /** `SET NX EX` : le premier appel de l'heure gagne, les suivants passent. */
  private async acquireRecomputeSlot(userId: string): Promise<boolean> {
    const acquired = await this.redis.set(
      `${RECOMPUTE_LIMIT_KEY_PREFIX}${userId}`,
      '1',
      'EX',
      RECOMPUTE_LIMIT_TTL_SECONDS,
      'NX',
    );

    return acquired === 'OK';
  }
}

/**
 * Verdict à partir des taux bruts. Sous le volume minimum, aucun verdict de
 * sanction ni d'alerte : sur 3 envois, un seul rebond ferait 33 % et
 * suspendrait un client parfaitement légitime.
 */
export function resolveVerdict(
  sent: number,
  bounceRate: number,
  complaintRate: number,
): ReputationVerdict {
  if (sent < MIN_VOLUME_FOR_SANCTION) {
    return 'OK';
  }

  if (bounceRate > MAX_BOUNCE_RATE || complaintRate > MAX_COMPLAINT_RATE) {
    return 'SUSPEND';
  }

  if (
    bounceRate >= MAX_BOUNCE_RATE * WARNING_THRESHOLD_RATIO ||
    complaintRate >= MAX_COMPLAINT_RATE * WARNING_THRESHOLD_RATIO
  ) {
    return 'WARNING';
  }

  return 'OK';
}

/** Palier atteint : le premier seuil satisfait (les paliers sont décroissants). */
export function resolveDailyLimit(
  ageDays: number,
  lifetimeSends: number,
): number {
  const tier = SEND_LIMIT_TIERS.find(
    (candidate) =>
      ageDays >= candidate.minAgeDays &&
      lifetimeSends >= candidate.minLifetimeSends,
  );

  return tier?.dailyLimit ?? DEFAULT_DAILY_SEND_LIMIT;
}

function ageInDays(createdAt: Date): number {
  return (Date.now() - createdAt.getTime()) / DAY_MS;
}

function describeMetrics(metrics: ReputationMetrics): string {
  return (
    `${metrics.sent} envois, ${metrics.bounces} rebonds (${formatRate(metrics.bounceRate)}), ` +
    `${metrics.complaints} plaintes (${formatRate(metrics.complaintRate)}) sur ${REPUTATION_WINDOW_DAYS} jours`
  );
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)} %`;
}

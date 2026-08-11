import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EmailStatus, UserStatus } from '@prisma/client';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { HARD_BOUNCE_ERROR_PREFIX } from '../sns-webhook/sns-webhook.types';
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
  reputationResetAt: true,
  createdAt: true,
} satisfies Record<keyof ReputationUser, true>;

/**
 * Protection de la réputation d'envoi — mitigation du risque n°1 du produit :
 * les taux de rebond et de plainte sont mesurés par AWS **au niveau du compte
 * SES entier**, donc un seul client abusif peut faire suspendre Zendou et
 * couper tous les autres clients. On suspend le client fautif nous-mêmes,
 * avant qu'AWS ne nous suspende.
 *
 * Seuls les rebonds **durs** alimentent le taux sanctionné (cf.
 * `MAX_BOUNCE_RATE`) : les transitoires sont comptés et exposés, jamais
 * sanctionnés.
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
    const since = windowStart(user);

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

    const hardBounces =
      bounces === 0 ? 0 : await this.countHardBounces(user.id, since);

    // Les deux requêtes ne sont pas dans une transaction : un rebond arrivé
    // entre les deux ne doit pas produire un compteur négatif.
    const transientBounces = Math.max(bounces - hardBounces, 0);

    // Seuls les rebonds durs sanctionnent ; les transitoires restent visibles.
    const bounceRate = sent === 0 ? 0 : hardBounces / sent;
    const complaintRate = sent === 0 ? 0 : complaints / sent;

    const metrics: ReputationMetrics = {
      sent,
      bounces,
      hardBounces,
      transientBounces,
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

  /**
   * Rebonds durs de la fenêtre — reconnus au préfixe que le webhook SNS
   * écrit dans `errorMessage` (le schéma n'a pas de colonne dédiée).
   *
   * Un `count` ciblé de plus, jamais un chargement de lignes : la base fait
   * l'agrégation, et l'index `(userId, queuedAt)` porte déjà la sélection de
   * la fenêtre. La requête n'est même pas payée quand la fenêtre ne contient
   * aucun rebond — le cas de l'immense majorité des évaluations.
   */
  private countHardBounces(userId: string, since: Date): Promise<number> {
    return this.prisma.email.count({
      where: {
        userId,
        queuedAt: { gte: since },
        status: EmailStatus.BOUNCED,
        errorMessage: { startsWith: HARD_BOUNCE_ERROR_PREFIX },
      },
    });
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

    // `suspendedAt`/`suspensionReason` sont posés ici comme ils le sont par
    // une suspension administrative : l'écran admin affiche la même chose,
    // quelle que soit l'origine de la suspension.
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        status: UserStatus.SUSPENDED,
        suspendedAt: new Date(),
        suspensionReason: buildSuspensionReason(metrics),
      },
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

/**
 * Borne basse de la fenêtre d'observation : la plus **récente** entre les 30
 * jours glissants et la remise à zéro de réputation posée par la dernière
 * réactivation administrative.
 *
 * Sans cette borne, réactiver un compte ne servirait à rien : il traînerait
 * jusqu'à 30 jours de rebonds et de plaintes déjà sanctionnés, et le premier
 * rebond suivant la réactivation le re-suspendrait immédiatement. La remise à
 * zéro solde le passé — elle ne relâche aucun seuil, elle repart de zéro
 * (et le volume minimum protège de nouveau le compte le temps qu'il se
 * reconstitue un historique significatif).
 */
export function windowStart(user: { reputationResetAt: Date | null }): Date {
  const slidingWindow = new Date(Date.now() - REPUTATION_WINDOW_DAYS * DAY_MS);

  if (user.reputationResetAt && user.reputationResetAt > slidingWindow) {
    return user.reputationResetAt;
  }

  return slidingWindow;
}

/**
 * Raison lisible inscrite dans `User.suspensionReason` : le taux constaté et
 * le seuil franchi, pour que l'admin sache pourquoi sans relire les logs.
 */
export function buildSuspensionReason(metrics: ReputationMetrics): string {
  const crossed: string[] = [];

  if (metrics.bounceRate > MAX_BOUNCE_RATE) {
    crossed.push(
      `taux de rebonds durs ${formatRate(metrics.bounceRate)} ` +
        `(${metrics.hardBounces}/${metrics.sent}, seuil ${formatRate(MAX_BOUNCE_RATE)})`,
    );
  }

  if (metrics.complaintRate > MAX_COMPLAINT_RATE) {
    crossed.push(
      `taux de plaintes ${formatRate(metrics.complaintRate)} ` +
        `(${metrics.complaints}/${metrics.sent}, seuil ${formatRate(MAX_COMPLAINT_RATE)})`,
    );
  }

  return `Suspension automatique — ${crossed.join(' ; ')}`;
}

function ageInDays(createdAt: Date): number {
  return (Date.now() - createdAt.getTime()) / DAY_MS;
}

function describeMetrics(metrics: ReputationMetrics): string {
  return (
    `${metrics.sent} envois, ${metrics.hardBounces} rebonds durs (${formatRate(metrics.bounceRate)}), ` +
    `${metrics.transientBounces} transitoires ignorés, ` +
    `${metrics.complaints} plaintes (${formatRate(metrics.complaintRate)}) ` +
    `sur la fenêtre d'observation (${REPUTATION_WINDOW_DAYS} jours au maximum)`
  );
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)} %`;
}

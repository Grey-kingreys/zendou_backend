import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, UserRole } from '@prisma/client';
import { ACTIVE_CREDIT_ENTRY_WHERE } from '../billing/billing.constants';
import { EmailsService } from '../emails/emails.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountAnonymizationService } from './account-anonymization.service';
import {
  ACCOUNT_INACTIVITY_SCHEDULER,
  type AccountInactivityScheduler,
} from './account-inactivity.scheduler';
import {
  DAY_MS,
  INACTIVITY_ANONYMIZE_AFTER_MONTHS,
  INACTIVITY_SWEEP_BATCH_SIZE,
  INACTIVITY_WARNING_AFTER_MONTHS,
  INACTIVITY_WARNING_NOTICE_DAYS,
  addMonthsUtc,
} from './account-lifecycle.constants';
import {
  buildInactivityWarningEmail,
  buildLoginUrl,
} from './inactivity-warning.template';

/** Horloge injectable : les tests déplacent « maintenant » sans attendre 24 mois. */
export type AccountLifecycleClock = () => Date;
export const ACCOUNT_LIFECYCLE_CLOCK = Symbol('ACCOUNT_LIFECYCLE_CLOCK');

/** Bilan d'un passage, pour le journal et les tests. */
export interface InactivitySweepReport {
  warningsLifted: number;
  warned: number;
  anonymized: number;
}

/**
 * « Dernière activité au plus tard à `cutoff` ». La dernière activité est
 * `lastActivityAt`, à défaut `createdAt` : une donnée absente ne fait jamais
 * passer un compte pour inactif depuis toujours.
 */
function inactiveSince(cutoff: Date): Prisma.UserWhereInput {
  return {
    OR: [
      { lastActivityAt: { lte: cutoff } },
      { lastActivityAt: null, createdAt: { lte: cutoff } },
    ],
  };
}

/** Négation exacte de {@link inactiveSince}. */
function activeAfter(cutoff: Date): Prisma.UserWhereInput {
  return {
    OR: [
      { lastActivityAt: { gt: cutoff } },
      { lastActivityAt: null, createdAt: { gt: cutoff } },
    ],
  };
}

/**
 * Compte protégé : il a un mouvement de crédit autre que le bonus de
 * bienvenue (même critère que le blocage de la suppression). Il n'est ni
 * averti ni anonymisé automatiquement pour inactivité. Évalué à chaque
 * passage : sans mouvement protégé, le cycle normal reprend.
 */
const WITH_ACTIVE_CREDITS: Prisma.UserWhereInput = {
  creditEntries: { some: ACTIVE_CREDIT_ENTRY_WHERE },
};

/** Négation exacte de {@link WITH_ACTIVE_CREDITS}. */
const WITHOUT_ACTIVE_CREDITS: Prisma.UserWhereInput = {
  creditEntries: { none: ACTIVE_CREDIT_ENTRY_WHERE },
};

/**
 * Traitement quotidien des comptes inactifs (ANON-1), tel que promis par la
 * politique de confidentialité : un compte sans connexion ni envoi depuis
 * 24 mois est prévenu par email, puis anonymisé au moins 30 jours plus tard.
 *
 * Trois phases, dans cet ordre, à chaque passage :
 * 1. **lever** l'avertissement des comptes redevenus actifs (filet de
 *    sécurité : l'enregistrement d'activité le lève déjà en temps réel) ;
 * 2. **prévenir** les comptes à 23 mois d'inactivité, une seule fois : le
 *    marqueur daté `inactivityWarningSentAt` est posé avant l'envoi par une
 *    écriture conditionnelle, et retiré si l'envoi échoue ;
 * 3. **anonymiser** les comptes à 24 mois d'inactivité ET prévenus depuis
 *    30 jours au moins, par la même fonction que l'anonymisation admin.
 *
 * Les ADMIN et les comptes protégés (crédits hors bonus de bienvenue) sont
 * exclus des phases 2 et 3, et leur avertissement éventuel est levé (phase 1).
 */
@Injectable()
export class AccountInactivityService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AccountInactivityService.name);
  private started = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailsService: EmailsService,
    private readonly anonymization: AccountAnonymizationService,
    private readonly configService: ConfigService,
    @Inject(ACCOUNT_LIFECYCLE_CLOCK)
    private readonly now: AccountLifecycleClock,
    @Inject(ACCOUNT_INACTIVITY_SCHEDULER)
    private readonly scheduler: AccountInactivityScheduler,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.scheduler.start(() => this.runSweepSafely());
      this.started = true;
      this.logger.log('Traitement quotidien des comptes inactifs installé');
    } catch (error: unknown) {
      this.logger.error(
        'Impossible de planifier le traitement des comptes inactifs',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      await this.scheduler.stop();
    } catch (error: unknown) {
      this.logger.error(
        'Arrêt du planificateur des comptes inactifs en erreur',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** Point d'entrée du worker : n'échoue jamais, journalise. */
  async runSweepSafely(): Promise<void> {
    try {
      const report = await this.runSweep();
      this.logger.log(
        `Comptes inactifs : ${report.warningsLifted} avertissement(s) levé(s), ${report.warned} averti(s), ${report.anonymized} anonymisé(s)`,
      );
    } catch (error: unknown) {
      this.logger.error(
        'Traitement des comptes inactifs en échec',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async runSweep(): Promise<InactivitySweepReport> {
    const now = this.now();
    const warningCutoff = addMonthsUtc(now, -INACTIVITY_WARNING_AFTER_MONTHS);
    const anonymizeCutoff = addMonthsUtc(
      now,
      -INACTIVITY_ANONYMIZE_AFTER_MONTHS,
    );
    const warnedBefore = new Date(
      now.getTime() - INACTIVITY_WARNING_NOTICE_DAYS * DAY_MS,
    );

    const warningsLifted = await this.liftWarnings(warningCutoff);
    const warned = await this.warn(now, warningCutoff);
    const anonymized = await this.anonymizeDue(anonymizeCutoff, warnedBefore);

    return { warningsLifted, warned, anonymized };
  }

  /** Phase 1 : un compte redevenu actif (ou promu admin) n'est plus averti. */
  private async liftWarnings(warningCutoff: Date): Promise<number> {
    const lifted = await this.prisma.user.updateMany({
      where: {
        inactivityWarningSentAt: { not: null },
        anonymizedAt: null,
        OR: [
          { role: UserRole.ADMIN },
          WITH_ACTIVE_CREDITS,
          activeAfter(warningCutoff),
        ],
      },
      data: { inactivityWarningSentAt: null },
    });

    return lifted.count;
  }

  /** Phase 2 : un avertissement par compte et par période d'inactivité. */
  private async warn(now: Date, warningCutoff: Date): Promise<number> {
    const eligible: Prisma.UserWhereInput = {
      role: UserRole.CUSTOMER,
      anonymizedAt: null,
      inactivityWarningSentAt: null,
      ...WITHOUT_ACTIVE_CREDITS,
      ...inactiveSince(warningCutoff),
    };

    const candidates = await this.prisma.user.findMany({
      where: eligible,
      select: {
        id: true,
        email: true,
        name: true,
        lastActivityAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: INACTIVITY_SWEEP_BATCH_SIZE,
    });

    let warned = 0;

    for (const candidate of candidates) {
      // Le marqueur est posé AVANT l'envoi, par une écriture conditionnelle :
      // deux passages concurrents ne peuvent pas envoyer deux fois.
      const claimed = await this.prisma.user.updateMany({
        where: { id: candidate.id, ...eligible },
        data: { inactivityWarningSentAt: now },
      });

      if (claimed.count === 0) {
        continue;
      }

      const lastActivity = candidate.lastActivityAt ?? candidate.createdAt;
      const anonymizationDate = new Date(
        Math.max(
          addMonthsUtc(
            lastActivity,
            INACTIVITY_ANONYMIZE_AFTER_MONTHS,
          ).getTime(),
          now.getTime() + INACTIVITY_WARNING_NOTICE_DAYS * DAY_MS,
        ),
      );
      const email = buildInactivityWarningEmail({
        name: candidate.name,
        anonymizationDate,
        loginUrl: buildLoginUrl(this.appBaseUrl()),
      });

      try {
        // `suppressed` compte comme un avertissement donné : l'adresse est
        // morte (rebond dur ou plainte), il n'en existe pas d'autre, et ne
        // jamais marquer le compte le garderait indéfiniment.
        await this.emailsService.sendSystem({
          userId: candidate.id,
          to: candidate.email,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
        warned += 1;
      } catch (error: unknown) {
        // Envoi impossible (configuration, Redis) : le marqueur est retiré,
        // le compte sera repris au prochain passage. Jamais anonymisé sans
        // avertissement.
        await this.prisma.user.updateMany({
          where: { id: candidate.id, inactivityWarningSentAt: now },
          data: { inactivityWarningSentAt: null },
        });
        this.logger.error(
          `Avertissement d'inactivité non envoyé au compte ${candidate.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return warned;
  }

  /** Phase 3 : 24 mois d'inactivité ET 30 jours depuis l'avertissement. */
  private async anonymizeDue(
    anonymizeCutoff: Date,
    warnedBefore: Date,
  ): Promise<number> {
    const due = await this.prisma.user.findMany({
      where: {
        role: UserRole.CUSTOMER,
        anonymizedAt: null,
        inactivityWarningSentAt: { not: null, lte: warnedBefore },
        ...WITHOUT_ACTIVE_CREDITS,
        ...inactiveSince(anonymizeCutoff),
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: INACTIVITY_SWEEP_BATCH_SIZE,
    });

    let anonymized = 0;

    for (const { id } of due) {
      try {
        const result = await this.anonymization.anonymize(id, {
          kind: 'inactivity',
          inactiveSince: anonymizeCutoff,
          warnedBefore,
        });

        if (result) {
          anonymized += 1;
          for (const action of result.remainingActions) {
            this.logger.error(
              `Anonymisation de ${id}, reste à faire : ${action}`,
            );
          }
        }
      } catch (error: unknown) {
        this.logger.error(
          `Anonymisation pour inactivité du compte ${id} en échec`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return anonymized;
  }

  /** Base des liens : `APP_BASE_URL`, à défaut `FRONTEND_ORIGIN`. */
  private appBaseUrl(): string {
    const configured = (
      this.configService.get<string>('APP_BASE_URL') ?? ''
    ).trim();

    return (
      configured || (this.configService.get<string>('FRONTEND_ORIGIN') ?? '')
    );
  }
}

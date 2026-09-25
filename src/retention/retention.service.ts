import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import {
  EMAIL_LOG_DELETE_BATCH_SIZE,
  FAILED_JOB_CLEAN_BATCH_LIMIT,
  FAILED_JOB_CLEAN_GRACE_MS,
  RETENTION_CLOCK,
  emailLogRetentionCutoff,
  type RetentionClock,
} from './retention.constants';
import {
  RETENTION_SCHEDULER,
  type RetentionScheduler,
} from './retention.scheduler';

/**
 * Rétention automatique des données d'envoi (RET-12).
 *
 * Corrige RD1 (`docs/plans/ACTIVE.md`, vague 20) : jusqu'ici, un job
 * `email-send` en échec définitif gardait son corps (html/text, ou message
 * brut SMTP) dans Redis sans limite, avec `removeOnComplete: true` mais
 * aucun `removeOnFail`. Deux volets, exécutés par la même tâche quotidienne :
 *
 * 1. **Jobs en échec de plus de 7 jours** : `removeOnFail` (posé par
 *    `EmailsService` à la mise en file) ne s'applique qu'aux jobs qui
 *    échouent après son introduction. Ce service rattrape aussi les jobs
 *    déjà en échec avant le déploiement, par `queue.clean(…, 'failed')`, en
 *    boucle jusqu'à épuisement.
 * 2. **Lignes `Email` de plus de 6 mois** : supprimées par lots bornés.
 *    N'affecte ni `Suppression` (liste de suppression : protection de
 *    délivrabilité, pas un journal, elle doit survivre) ni `CreditEntry`
 *    (traces de paiement : `reference` reste le `publicId`, même orpheline).
 *
 * **Actif dans tous les environnements, sans condition**, contrairement à
 * `SmtpCertAlertService` (B6/H1), qui n'est armé que si `SMTP_RELAY_ENABLED`
 * l'est. La purge est une garantie de la politique de confidentialité, pas
 * une option d'exploitation.
 *
 * Même invariant n°2 que `SmtpCertAlertService` : rien ici ne peut faire
 * échouer un démarrage ni tuer un worker. Un échec de purge est journalisé
 * et avalé, le prochain passage (24 h plus tard) réessaiera.
 */
@Injectable()
export class RetentionService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RetentionService.name);
  private started = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EMAIL_SEND_QUEUE)
    private readonly emailQueue: Queue,
    @Inject(RETENTION_SCHEDULER)
    private readonly scheduler: RetentionScheduler,
    @Inject(RETENTION_CLOCK)
    private readonly now: RetentionClock,
  ) {}

  /**
   * Purge immédiate au démarrage, **puis** installation de la tâche
   * quotidienne : même séquence que `SmtpCertAlertService.onApplicationBootstrap`.
   * Le passage au démarrage n'est pas un doublon de la tâche répétable : il
   * évite qu'un service resté éteint plusieurs jours accumule un retard avant
   * son premier passage programmé.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.runPurge();

    try {
      await this.scheduler.start(() => this.runPurge());
      this.started = true;
      this.logger.log('Purge de rétention installée (passage quotidien)');
    } catch (error: unknown) {
      // Invariant n°2 : Redis indisponible au démarrage ne doit pas empêcher
      // l'API de servir. Le passage au démarrage, lui, a déjà eu lieu (et
      // n'a pas besoin de BullMQ : voir `runPurge`).
      this.logger.error(
        'Impossible de planifier la purge quotidienne de rétention',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.started) {
      try {
        await this.scheduler.stop();
      } catch (error: unknown) {
        this.logger.error(
          'Arrêt du planificateur de rétention en erreur',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  /**
   * Un passage complet des deux purges. Exécuté au démarrage et par la tâche
   * quotidienne. Ne rejette jamais : chaque volet est isolé dans son propre
   * `try/catch` pour qu'un échec de l'un n'empêche pas l'autre de s'exécuter.
   */
  async runPurge(): Promise<void> {
    try {
      await this.cleanFailedJobs();
    } catch (error: unknown) {
      this.logger.error(
        'Nettoyage des jobs en échec en erreur',
        error instanceof Error ? error.stack : String(error),
      );
    }

    try {
      await this.purgeOldEmails();
    } catch (error: unknown) {
      this.logger.error(
        'Purge du journal des envois en erreur',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Supprime, par lots bornés, tout job `failed` de la file `email-send` âgé
   * de plus de 7 jours, quel que soit son âge de **création** : `clean`
   * filtre sur l'âge du job dans son état actuel (ici, `finishedOn`), ce qui
   * couvre aussi bien un job créé hier et échoué aujourd'hui qu'un job échoué
   * il y a huit mois, jamais purgé faute de `removeOnFail` avant ce lot.
   */
  private async cleanFailedJobs(): Promise<void> {
    let total = 0;

    for (;;) {
      const removed = await this.emailQueue.clean(
        FAILED_JOB_CLEAN_GRACE_MS,
        FAILED_JOB_CLEAN_BATCH_LIMIT,
        'failed',
      );
      total += removed.length;

      if (removed.length < FAILED_JOB_CLEAN_BATCH_LIMIT) {
        break;
      }
    }

    this.logger.log(
      `Nettoyage des jobs en échec : ${total} job(s) supprimé(s) (plus de 7 jours)`,
    );
  }

  /**
   * Supprime, par lots bornés, toute ligne `Email` dont `queuedAt` dépasse le
   * seuil de rétention (voir {@link emailLogRetentionCutoff} pour le choix de
   * `queuedAt`). Sélection puis suppression par identifiants plutôt qu'un
   * `deleteMany` unique sur toute la table : un historique de plusieurs
   * millions de lignes ne doit jamais tenir dans une seule transaction.
   *
   * N'écrit rien ailleurs : `Suppression` n'est jamais lue ni touchée ici, et
   * `CreditEntry` n'a aucune contrainte de clé étrangère vers `Email` (sa
   * colonne `reference` porte le `publicId` comme simple chaîne) : la ligne
   * `Email` peut donc disparaître sans qu'aucune contrainte n'empêche la
   * suppression et sans qu'aucune ligne `CreditEntry` ne soit affectée.
   */
  private async purgeOldEmails(): Promise<void> {
    const cutoff = emailLogRetentionCutoff(this.now());
    let total = 0;

    for (;;) {
      const batch = await this.prisma.email.findMany({
        where: { queuedAt: { lt: cutoff } },
        select: { id: true },
        take: EMAIL_LOG_DELETE_BATCH_SIZE,
      });

      if (batch.length === 0) {
        break;
      }

      const ids = batch.map((row) => row.id);
      await this.prisma.email.deleteMany({ where: { id: { in: ids } } });
      total += ids.length;

      if (batch.length < EMAIL_LOG_DELETE_BATCH_SIZE) {
        break;
      }
    }

    this.logger.log(
      `Purge du journal des envois : ${total} ligne(s) supprimée(s) (queuedAt de plus de 6 mois)`,
    );
  }
}

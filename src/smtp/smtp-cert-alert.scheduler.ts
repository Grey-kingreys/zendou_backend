import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { SMTP_CERT_CHECK_QUEUE } from '../queues/queues';
import {
  SMTP_CERT_ALERT_INTERVAL_MS,
  SMTP_CERT_ALERT_JOB_NAME,
  SMTP_CERT_ALERT_SCHEDULER_ID,
} from './smtp-cert-alert.constants';

/**
 * Ce dont la surveillance a besoin d'un planificateur, et rien de plus (B6/H1).
 *
 * Un port plutôt qu'une dépendance directe à BullMQ : les tests de politique
 * assertent « aucune tâche planifiée » en constatant que {@link start} n'a pas
 * été appelé, sans jamais ouvrir de connexion Redis.
 */
export interface SmtpCertAlertScheduler {
  /** Installe la tâche répétable et démarre le worker qui l'exécute. */
  start(run: () => Promise<void>): Promise<void>;
  /** Ferme worker et file — appelé à l'arrêt du module. */
  stop(): Promise<void>;
}

/** Jeton d'injection du port {@link SmtpCertAlertScheduler}. */
export const SMTP_CERT_ALERT_SCHEDULER = Symbol('SMTP_CERT_ALERT_SCHEDULER');

/**
 * Planificateur BullMQ : tâche répétable quotidienne (`upsertJobScheduler`).
 *
 * Pourquoi BullMQ et non un `setInterval` : le contrôle doit avoir lieu **une
 * fois par jour pour le service**, pas une fois par jour et par réplique. Un
 * minuteur local enverrait autant d'alertes que d'instances déployées ; la
 * tâche répétable, elle, vit dans Redis et n'est exécutée que par un worker à
 * la fois. C'est aussi la raison pour laquelle la file et le worker sont créés
 * **ici**, à l'appel de `start`, et non par `BullModule.registerQueue` ou un
 * `@Processor` : ceux-là ouvriraient leurs connexions Redis dans tous les
 * environnements, y compris ceux où le relais est désactivé — soit exactement
 * l'inertie que ce lot s'interdit de rompre.
 */
@Injectable()
export class BullSmtpCertAlertScheduler implements SmtpCertAlertScheduler {
  private readonly logger = new Logger(BullSmtpCertAlertScheduler.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(private readonly configService: ConfigService) {}

  async start(run: () => Promise<void>): Promise<void> {
    const connection = { url: this.configService.get<string>('REDIS_URL') };

    this.worker = new Worker(
      SMTP_CERT_CHECK_QUEUE,
      async () => {
        await run();
      },
      { connection },
    );

    // Sans écouteur, une coupure Redis remonterait en exception non capturée
    // et tuerait le processus — un worker de surveillance ne doit jamais
    // emporter l'API avec lui.
    this.worker.on('error', (error: Error) => {
      this.logger.error(
        'Worker de surveillance du certificat SMTP en erreur',
        error.stack ?? error.message,
      );
    });

    this.queue = new Queue(SMTP_CERT_CHECK_QUEUE, { connection });

    await this.queue.upsertJobScheduler(
      SMTP_CERT_ALERT_SCHEDULER_ID,
      { every: SMTP_CERT_ALERT_INTERVAL_MS },
      {
        name: SMTP_CERT_ALERT_JOB_NAME,
        opts: { removeOnComplete: 10, removeOnFail: 20 },
      },
    );
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.worker = null;
    this.queue = null;
  }
}

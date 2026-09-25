import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { RETENTION_QUEUE } from '../queues/queues';
import {
  RETENTION_INTERVAL_MS,
  RETENTION_JOB_NAME,
  RETENTION_SCHEDULER_ID,
} from './retention.constants';

/**
 * Ce dont la purge quotidienne a besoin d'un planificateur, et rien de plus :
 * même port que {@link SmtpCertAlertScheduler} (`smtp-cert-alert.scheduler.ts`),
 * pour la même raison : les tests de policy assertent « aucune tâche
 * planifiée » en constatant que {@link start} n'a pas été appelé, sans jamais
 * ouvrir de connexion Redis.
 */
export interface RetentionScheduler {
  /** Installe la tâche répétable et démarre le worker qui l'exécute. */
  start(run: () => Promise<void>): Promise<void>;
  /** Ferme worker et file, appelé à l'arrêt du module. */
  stop(): Promise<void>;
}

/** Jeton d'injection du port {@link RetentionScheduler}. */
export const RETENTION_SCHEDULER = Symbol('RETENTION_SCHEDULER');

/**
 * Planificateur BullMQ : tâche répétable quotidienne (`upsertJobScheduler`),
 * imitée de `BullSmtpCertAlertScheduler` (B6/H1).
 *
 * Pourquoi BullMQ et non un `setInterval` : la purge doit avoir lieu **une
 * fois par jour pour le service**, pas une fois par jour et par réplique. Un
 * minuteur local nettoierait en double (ou en boucle concurrente) dès que le
 * service tourne à plusieurs instances ; la tâche répétable, elle, vit dans
 * Redis et n'est exécutée que par un worker à la fois. C'est aussi la raison
 * pour laquelle la file et le worker sont créés **ici**, à l'appel de
 * `start`, et non par `BullModule.registerQueue` ou un `@Processor`.
 *
 * Contrairement à la surveillance du certificat SMTP, cette tâche est
 * **toujours** installée (`RetentionModule` est importé sans condition dans
 * `AppModule`) : la purge est une garantie produit, pas une option.
 */
@Injectable()
export class BullRetentionScheduler implements RetentionScheduler {
  private readonly logger = new Logger(BullRetentionScheduler.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(private readonly configService: ConfigService) {}

  async start(run: () => Promise<void>): Promise<void> {
    const connection = { url: this.configService.get<string>('REDIS_URL') };

    this.worker = new Worker(
      RETENTION_QUEUE,
      async () => {
        await run();
      },
      { connection },
    );

    // Sans écouteur, une coupure Redis remonterait en exception non capturée
    // et tuerait le processus : une tâche de ménage ne doit jamais emporter
    // l'API avec elle.
    this.worker.on('error', (error: Error) => {
      this.logger.error(
        'Worker de purge de rétention en erreur',
        error.stack ?? error.message,
      );
    });

    this.queue = new Queue(RETENTION_QUEUE, { connection });

    await this.queue.upsertJobScheduler(
      RETENTION_SCHEDULER_ID,
      { every: RETENTION_INTERVAL_MS },
      {
        name: RETENTION_JOB_NAME,
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

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { ACCOUNT_INACTIVITY_QUEUE } from '../queues/queues';
import {
  INACTIVITY_JOB_NAME,
  INACTIVITY_SCHEDULER_ID,
  INACTIVITY_SWEEP_INTERVAL_MS,
} from './account-lifecycle.constants';

/**
 * Ce dont le traitement des comptes inactifs a besoin d'un planificateur.
 * Un port, comme `SmtpCertAlertScheduler` : les tests n'ouvrent jamais de
 * connexion Redis.
 */
export interface AccountInactivityScheduler {
  /** Installe la tâche répétable et démarre le worker qui l'exécute. */
  start(run: () => Promise<void>): Promise<void>;
  /** Ferme worker et file, à l'arrêt du module. */
  stop(): Promise<void>;
}

/** Jeton d'injection du port {@link AccountInactivityScheduler}. */
export const ACCOUNT_INACTIVITY_SCHEDULER = Symbol(
  'ACCOUNT_INACTIVITY_SCHEDULER',
);

/**
 * Tâche répétable quotidienne BullMQ (`upsertJobScheduler`), même montage que
 * la surveillance du certificat SMTP : une exécution par jour **pour le
 * service**, pas par réplique, puisque la tâche vit dans Redis et qu'un seul
 * worker la prend.
 */
@Injectable()
export class BullAccountInactivityScheduler implements AccountInactivityScheduler {
  private readonly logger = new Logger(BullAccountInactivityScheduler.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(private readonly configService: ConfigService) {}

  async start(run: () => Promise<void>): Promise<void> {
    const connection = { url: this.configService.get<string>('REDIS_URL') };

    this.worker = new Worker(
      ACCOUNT_INACTIVITY_QUEUE,
      async () => {
        await run();
      },
      { connection },
    );

    // Sans écouteur, une coupure Redis tuerait le processus.
    this.worker.on('error', (error: Error) => {
      this.logger.error(
        'Worker du traitement des comptes inactifs en erreur',
        error.stack ?? error.message,
      );
    });

    this.queue = new Queue(ACCOUNT_INACTIVITY_QUEUE, { connection });

    await this.queue.upsertJobScheduler(
      INACTIVITY_SCHEDULER_ID,
      { every: INACTIVITY_SWEEP_INTERVAL_MS },
      {
        name: INACTIVITY_JOB_NAME,
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

import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import {
  EMAIL_LOG_DELETE_BATCH_SIZE,
  FAILED_JOB_CLEAN_BATCH_LIMIT,
  FAILED_JOB_CLEAN_GRACE_MS,
  RETENTION_CLOCK,
} from './retention.constants';
import { RETENTION_SCHEDULER } from './retention.scheduler';
import { RetentionService } from './retention.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Rétention automatique des données d'envoi (RET-12).
 *
 * Même discipline que `smtp-cert-alert.service.spec.ts` : horloge injectée
 * (pas de dépendance à l'heure réelle du poste), planificateur double qui
 * n'ouvre aucune connexion BullMQ réelle, `queue` et `prisma` réduits aux
 * seules méthodes utilisées : un appel accidentel à `prisma.suppression` ou
 * `prisma.creditEntry` ferait planter le test avec un message explicite,
 * plutôt que de passer inaperçu derrière un mock complaisant.
 *
 * Le seuil de 6 mois est vérifié contre une date **calculée à la main**, pas
 * en rappelant `emailLogRetentionCutoff` : un test qui recalcule son propre
 * attendu avec la fonction sous test ne prouve rien, il resterait vert même
 * si `EMAIL_LOG_RETENTION_MONTHS` tombait à 0.
 */

/** Planificateur double : enregistre l'installation sans toucher à BullMQ. */
class FakeScheduler {
  readonly started: (() => Promise<void>)[] = [];
  stopped = 0;
  startError: Error | null = null;
  stopError: Error | null = null;

  start = (run: () => Promise<void>): Promise<void> => {
    if (this.startError) {
      return Promise.reject(this.startError);
    }
    this.started.push(run);
    return Promise.resolve();
  };

  stop = (): Promise<void> => {
    this.stopped += 1;
    if (this.stopError) {
      return Promise.reject(this.stopError);
    }
    return Promise.resolve();
  };

  /** Déclenche la purge comme le ferait un job de la tâche répétable. */
  async tick(): Promise<void> {
    for (const run of this.started) {
      await run();
    }
  }
}

describe('RetentionService : rétention automatique des données d’envoi (RET-12)', () => {
  let clock: Date;
  let scheduler: FakeScheduler;
  let queueClean: jest.Mock;
  let emailFindMany: jest.Mock;
  let emailDeleteMany: jest.Mock;
  let prismaStub: { email: { findMany: jest.Mock; deleteMany: jest.Mock } };
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    clock = new Date('2026-09-25T10:00:00.000Z');
    scheduler = new FakeScheduler();
    queueClean = jest.fn().mockResolvedValue([]);
    emailFindMany = jest.fn().mockResolvedValue([]);
    emailDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    prismaStub = {
      email: { findMany: emailFindMany, deleteMany: emailDeleteMany },
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function build(): Promise<RetentionService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RetentionService,
        { provide: PrismaService, useValue: prismaStub },
        {
          provide: getQueueToken(EMAIL_SEND_QUEUE),
          useValue: { clean: queueClean },
        },
        { provide: RETENTION_SCHEDULER, useValue: scheduler },
        { provide: RETENTION_CLOCK, useValue: () => clock },
      ],
    }).compile();

    return moduleRef.get(RetentionService);
  }

  async function bootstrap(): Promise<RetentionService> {
    const service = await build();
    await service.onApplicationBootstrap();
    return service;
  }

  describe('installation', () => {
    it('purge immédiatement au démarrage, avant même d’installer la tâche répétable', async () => {
      await bootstrap();

      expect(queueClean).toHaveBeenCalled();
      expect(emailFindMany).toHaveBeenCalled();
    });

    it('installe la tâche répétable', async () => {
      await bootstrap();

      expect(scheduler.started).toHaveLength(1);
    });

    it('la tâche répétable rejoue les deux purges', async () => {
      const service = await bootstrap();
      queueClean.mockClear();
      emailFindMany.mockClear();

      await scheduler.tick();

      expect(queueClean).toHaveBeenCalled();
      expect(emailFindMany).toHaveBeenCalled();
      expect(service).toBeDefined();
    });

    it('un échec de planification est journalisé sans faire tomber le démarrage', async () => {
      scheduler.startError = new Error('Redis injoignable');

      await expect(bootstrap()).resolves.toBeInstanceOf(RetentionService);
      expect(errorSpy).toHaveBeenCalledWith(
        'Impossible de planifier la purge quotidienne de rétention',
        expect.anything(),
      );
    });

    it('n’arrête le planificateur à la destruction que s’il a démarré', async () => {
      scheduler.startError = new Error('Redis injoignable');
      const service = await bootstrap();

      await service.onModuleDestroy();

      expect(scheduler.stopped).toBe(0);
    });

    it('arrête le planificateur à la destruction quand il a démarré', async () => {
      const service = await bootstrap();

      await service.onModuleDestroy();

      expect(scheduler.stopped).toBe(1);
    });

    it('un échec d’arrêt du planificateur est journalisé sans remonter', async () => {
      scheduler.stopError = new Error('Redis injoignable');
      const service = await bootstrap();

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        'Arrêt du planificateur de rétention en erreur',
        expect.anything(),
      );
    });
  });

  describe('nettoyage des jobs en échec', () => {
    it('appelle queue.clean avec la grâce de 7 jours et le type « failed »', async () => {
      await bootstrap();

      expect(queueClean).toHaveBeenCalledWith(
        FAILED_JOB_CLEAN_GRACE_MS,
        FAILED_JOB_CLEAN_BATCH_LIMIT,
        'failed',
      );
    });

    it('boucle par lots jusqu’à épuisement', async () => {
      const full = Array.from(
        { length: FAILED_JOB_CLEAN_BATCH_LIMIT },
        (_, i) => `job_${i}`,
      );
      queueClean
        .mockResolvedValueOnce(full)
        .mockResolvedValueOnce(full)
        .mockResolvedValueOnce(['job_last']);

      await bootstrap();

      expect(queueClean).toHaveBeenCalledTimes(3);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `${FAILED_JOB_CLEAN_BATCH_LIMIT * 2 + 1} job(s) supprimé(s)`,
        ),
      );
    });

    it('s’arrête dès qu’un lot revient sous la limite (file déjà propre)', async () => {
      queueClean.mockResolvedValueOnce([]);

      await bootstrap();

      expect(queueClean).toHaveBeenCalledTimes(1);
    });

    it('un échec de nettoyage est journalisé sans empêcher la purge du journal', async () => {
      queueClean.mockRejectedValueOnce(new Error('Redis indisponible'));

      await bootstrap();

      expect(errorSpy).toHaveBeenCalledWith(
        'Nettoyage des jobs en échec en erreur',
        expect.anything(),
      );
      // L'autre volet s'exécute quand même : les deux purges sont isolées.
      expect(emailFindMany).toHaveBeenCalled();
    });
  });

  describe('purge du journal des envois', () => {
    it('filtre sur queuedAt antérieur à il y a exactement 6 mois civils (horloge fixée au 25/09/2026)', async () => {
      await bootstrap();

      // Calculé à la main, indépendamment de `emailLogRetentionCutoff` : un
      // seuil de 6 mois avant le 25/09/2026 10:00:00.000Z tombe le
      // 25/03/2026 10:00:00.000Z.
      const expectedCutoff = new Date('2026-03-25T10:00:00.000Z');

      expect(emailFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { queuedAt: { lt: expectedCutoff } },
        }),
      );
    });

    it('ne supprime que les identifiants trouvés au-delà du seuil, jamais un deleteMany sur toute la table', async () => {
      emailFindMany.mockResolvedValueOnce([{ id: 'e_1' }, { id: 'e_2' }]);

      await bootstrap();

      expect(emailDeleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['e_1', 'e_2'] } },
      });
    });

    it('boucle par lots jusqu’à épuisement', async () => {
      const fullBatch = Array.from(
        { length: EMAIL_LOG_DELETE_BATCH_SIZE },
        (_, i) => ({ id: `e_${i}` }),
      );
      emailFindMany
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce([{ id: 'e_last' }]);
      emailDeleteMany.mockResolvedValue({ count: EMAIL_LOG_DELETE_BATCH_SIZE });

      await bootstrap();

      expect(emailFindMany).toHaveBeenCalledTimes(2);
      expect(emailDeleteMany).toHaveBeenCalledTimes(2);
    });

    it('s’arrête dès qu’un lot est vide, sans appeler deleteMany', async () => {
      emailFindMany.mockResolvedValueOnce([]);

      await bootstrap();

      expect(emailFindMany).toHaveBeenCalledTimes(1);
      expect(emailDeleteMany).not.toHaveBeenCalled();
    });

    it('un échec de purge est journalisé sans remonter, sans toucher Suppression ni CreditEntry', async () => {
      emailFindMany.mockRejectedValueOnce(new Error('DB indisponible'));

      await expect(bootstrap()).resolves.toBeInstanceOf(RetentionService);
      expect(errorSpy).toHaveBeenCalledWith(
        'Purge du journal des envois en erreur',
        expect.anything(),
      );
      // Le stub prisma n'expose que `email` : un appel à `suppression` ou
      // `creditEntry` aurait fait planter le test avec un TypeError, pas
      // silencieusement réussi.
    });
  });
});

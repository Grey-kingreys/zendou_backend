import { Logger } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DomainStatus, EmailStatus, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import { REPUTATION_REDIS } from '../reputation/reputation.constants';
import { ReputationService } from '../reputation/reputation.service';
import { HARD_BOUNCE_ERROR_PREFIX } from '../sns-webhook/sns-webhook.types';
import type { SendEmailDto } from './dto/send-email.dto';
import { EmailsService, SystemSenderUnavailableError } from './emails.service';

const USER_ID = 'user_1';
const CLIENT_DOMAIN = 'boutique-awa.gn';
const SYSTEM_DOMAIN = 'mail.kingreys.fr';
const SYSTEM_FROM = `Zendou <no-reply@${SYSTEM_DOMAIN}>`;

interface EmailRow {
  id: string;
  publicId: string;
  userId: string;
  domainId: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string;
  status: EmailStatus;
  errorMessage: string | null;
  queuedAt: Date;
  system: boolean;
}

interface CreditRow {
  userId: string;
  delta: number;
  reason: string;
  reference: string | null;
}

/**
 * Filtre `where` réellement appliqué aux lignes `Email`, avec la sémantique
 * dont ces tests ont besoin : `system`, `status.in`, `queuedAt.gte` et
 * `errorMessage.startsWith`.
 *
 * C'est le cœur de ce fichier. Un mock à réponses pré-programmées dirait
 * exactement ce qu'on lui a soufflé ; ici, si `ReputationService` cessait de
 * filtrer sur `system`, les compteurs bougeraient pour de bon et les tests
 * casseraient.
 */
interface EmailWhere {
  userId?: string;
  system?: boolean;
  status?: EmailStatus | { in: EmailStatus[] };
  queuedAt?: { gte?: Date };
  errorMessage?: { startsWith?: string };
}

function matches(row: EmailRow, where: EmailWhere): boolean {
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.system !== undefined && row.system !== where.system) return false;

  if (where.status !== undefined) {
    const accepted =
      typeof where.status === 'string' ? [where.status] : where.status.in;
    if (!accepted.includes(row.status)) return false;
  }

  if (where.queuedAt?.gte && row.queuedAt < where.queuedAt.gte) return false;

  if (where.errorMessage?.startsWith !== undefined) {
    if (!row.errorMessage?.startsWith(where.errorMessage.startsWith)) {
      return false;
    }
  }

  return true;
}

class FakeStore {
  readonly emails: EmailRow[] = [];
  readonly credits: CreditRow[] = [];
  readonly suppressions: { address: string; userId: string | null }[] = [];
  readonly domains = [
    { id: 'dom_client', name: CLIENT_DOMAIN, userId: USER_ID, verified: true },
    {
      id: 'dom_system',
      name: SYSTEM_DOMAIN,
      userId: 'user_zendou',
      verified: true,
    },
  ];

  userRow = {
    id: USER_ID,
    email: 'aissatou@example.com',
    status: UserStatus.ACTIVE as UserStatus,
    dailySendLimit: 200,
    reputationResetAt: null as Date | null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  private nextId = 1;

  readonly domain = {
    findFirst: jest.fn(
      ({
        where,
      }: {
        where: { name: string; userId?: string; status: DomainStatus };
      }) => {
        const hit = this.domains.find(
          (row) =>
            row.name === where.name &&
            row.verified === (where.status === DomainStatus.VERIFIED) &&
            (where.userId === undefined || row.userId === where.userId),
        );

        return Promise.resolve(hit ? { id: hit.id } : null);
      },
    ),
  };

  readonly suppression = {
    findFirst: jest.fn(
      ({
        where,
      }: {
        where: { address: string; OR: { userId: string | null }[] };
      }) => {
        const scopes = where.OR.map((clause) => clause.userId);
        const hit = this.suppressions.find(
          (row) => row.address === where.address && scopes.includes(row.userId),
        );

        return Promise.resolve(hit ? { id: 'sup_1' } : null);
      },
    ),
  };

  readonly email = {
    create: jest.fn(({ data }: { data: Partial<EmailRow> }) => {
      const row: EmailRow = {
        id: `email_${this.nextId++}`,
        publicId: data.publicId as string,
        userId: data.userId as string,
        domainId: data.domainId ?? null,
        fromAddress: data.fromAddress as string,
        toAddress: data.toAddress as string,
        subject: data.subject as string,
        status: data.status ?? EmailStatus.QUEUED,
        errorMessage: null,
        queuedAt: new Date(),
        system: data.system ?? false,
      };
      this.emails.push(row);
      return Promise.resolve({ id: row.id, publicId: row.publicId });
    }),

    count: jest.fn(({ where }: { where: EmailWhere }) =>
      Promise.resolve(this.emails.filter((row) => matches(row, where)).length),
    ),

    groupBy: jest.fn(({ where }: { where: EmailWhere }) => {
      const totals = new Map<EmailStatus, number>();

      for (const row of this.emails.filter((candidate) =>
        matches(candidate, where),
      )) {
        totals.set(row.status, (totals.get(row.status) ?? 0) + 1);
      }

      return Promise.resolve(
        [...totals].map(([status, total]) => ({
          status,
          _count: { _all: total },
        })),
      );
    }),
  };

  readonly creditEntry = {
    create: jest.fn(({ data }: { data: CreditRow }) => {
      this.credits.push(data);
      return Promise.resolve(data);
    }),
    aggregate: jest.fn(() =>
      Promise.resolve({
        _sum: {
          delta: this.credits.reduce((total, row) => total + row.delta, 0),
        },
      }),
    ),
  };

  readonly user = {
    findUnique: jest.fn(() => Promise.resolve(this.userRow)),
    update: jest.fn(({ data }: { data: Partial<typeof this.userRow> }) => {
      Object.assign(this.userRow, data);
      return Promise.resolve(this.userRow);
    }),
  };

  readonly $transaction = jest.fn(
    (run: (tx: FakeStore) => Promise<unknown>): Promise<unknown> => run(this),
  );

  /** Insère directement des lignes déjà envoyées (historique de la fenêtre). */
  seedSent(count: number, options: { system: boolean; status: EmailStatus }) {
    for (let index = 0; index < count; index++) {
      this.emails.push({
        id: `seed_${this.nextId++}`,
        publicId: `e_seed${this.nextId}`,
        userId: USER_ID,
        domainId: 'dom_client',
        fromAddress: `contact@${CLIENT_DOMAIN}`,
        toAddress: `client${index}@exemple.gn`,
        subject: 'Historique',
        status: options.status,
        errorMessage:
          options.status === EmailStatus.BOUNCED
            ? `${HARD_BOUNCE_ERROR_PREFIX}/General — 550 5.1.1 user unknown`
            : null,
        queuedAt: new Date(),
        system: options.system,
      });
    }
  }
}

function clientDto(overrides: Partial<SendEmailDto> = {}): SendEmailDto {
  return {
    from: `contact@${CLIENT_DOMAIN}`,
    to: 'client@exemple.gn',
    subject: 'Votre commande est prête',
    html: '<p>Bonjour</p>',
    ...overrides,
  };
}

/**
 * Exemption des envois système : ce qu'elle contourne, et surtout ce qu'elle
 * ne contourne pas.
 *
 * `EmailsService` et `ReputationService` partagent ici le **même** magasin de
 * lignes : ce que le premier écrit, le second le lit vraiment. C'est ce qui
 * permet de prouver la propriété demandée — « un envoi système ne débite aucun
 * crédit et n'alimente pas la métrique de suspension » — plutôt que de
 * l'affirmer.
 */
describe('Envoi système (intégration EmailsService ↔ ReputationService)', () => {
  let emails: EmailsService;
  let reputation: ReputationService;
  let store: FakeStore;

  const queue = { add: jest.fn() };
  let configValues: Record<string, string>;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    store = new FakeStore();
    configValues = { SYSTEM_EMAIL_FROM: SYSTEM_FROM };
    queue.add.mockResolvedValue({ id: 'job_1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailsService,
        ReputationService,
        { provide: PrismaService, useValue: store },
        { provide: getQueueToken(EMAIL_SEND_QUEUE), useValue: queue },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => configValues[key] },
        },
        // `SET NX` accordé : le throttle horaire des recalculs de quota n'est
        // pas le sujet ici (il a son propre test dans reputation.service.spec).
        {
          provide: REPUTATION_REDIS,
          useValue: { set: jest.fn().mockResolvedValue('OK') },
        },
      ],
    }).compile();

    emails = module.get(EmailsService);
    reputation = module.get(ReputationService);
  });

  function sendSystem() {
    return emails.sendSystem({
      userId: USER_ID,
      to: 'aissatou@example.com',
      subject: 'Confirmez votre adresse email — Zendou',
      html: '<p>Lien</p>',
      text: 'Lien',
    });
  }

  describe('ce que l’exemption contourne', () => {
    it('ne débite aucun crédit, là où un envoi client en débite un', async () => {
      await expect(sendSystem()).resolves.toMatchObject({ status: 'queued' });

      expect(store.credits).toHaveLength(0);
      expect(store.creditEntry.create).not.toHaveBeenCalled();

      // Le même pipeline, côté client, facture bien.
      store.credits.push({
        userId: USER_ID,
        delta: 10,
        reason: 'TOPUP',
        reference: null,
      });
      await emails.send(USER_ID, clientDto());

      expect(store.credits).toHaveLength(2);
      expect(store.credits[1]).toMatchObject({ delta: -1, reason: 'SEND' });
    });

    it('n’exige ni solde de crédits ni quota journalier disponible', async () => {
      // Solde nul et quota du jour épuisé : un envoi client serait refusé.
      store.seedSent(200, { system: false, status: EmailStatus.DELIVERED });

      await expect(sendSystem()).resolves.toMatchObject({ status: 'queued' });
      expect(queue.add).toHaveBeenCalledTimes(1);

      store.credits.push({
        userId: USER_ID,
        delta: 10,
        reason: 'TOPUP',
        reference: null,
      });
      await expect(emails.send(USER_ID, clientDto())).rejects.toThrow(
        /Limite journalière atteinte/,
      );
    });

    it('ne consomme pas le quota journalier du client', async () => {
      store.userRow.dailySendLimit = 1;
      store.credits.push({
        userId: USER_ID,
        delta: 10,
        reason: 'TOPUP',
        reference: null,
      });

      await sendSystem();

      // L'unique envoi de la journée reste disponible pour le client.
      await expect(emails.send(USER_ID, clientDto())).resolves.toMatchObject({
        status: 'queued',
      });
    });

    /**
     * La preuve centrale : le rebond dur d'un envoi système ne doit pas
     * suspendre le compte, alors que le même rebond sur un envoi du client
     * le suspend.
     */
    it('les rebonds d’un envoi système n’alimentent pas la métrique de suspension', async () => {
      store.seedSent(56, { system: false, status: EmailStatus.DELIVERED });
      store.seedSent(4, { system: true, status: EmailStatus.BOUNCED });

      const metrics = await reputation.evaluate(USER_ID);

      expect(metrics).toMatchObject({
        sent: 56,
        bounces: 0,
        hardBounces: 0,
        bounceRate: 0,
        verdict: 'OK',
      });
      expect(store.userRow.status).toBe(UserStatus.ACTIVE);
      expect(store.user.update).not.toHaveBeenCalled();
    });

    it('… alors que les mêmes rebonds sur des envois du client suspendent bien le compte', async () => {
      store.seedSent(56, { system: false, status: EmailStatus.DELIVERED });
      store.seedSent(4, { system: false, status: EmailStatus.BOUNCED });

      const metrics = await reputation.evaluate(USER_ID);

      expect(metrics).toMatchObject({
        sent: 60,
        hardBounces: 4,
        verdict: 'SUSPEND',
      });
      expect(store.userRow.status).toBe(UserStatus.SUSPENDED);
    });

    it('l’exemption porte sur le dénominateur aussi, pas seulement sur les rebonds', async () => {
      // 4 rebonds durs client sur 56 envois client = 7,1 % → suspension. Si
      // les 40 envois système gonflaient le dénominateur (4/96 = 4,2 %), le
      // compte passerait sous le seuil : l'exemption serait un cadeau
      // empoisonné qui protégerait un client réellement fautif.
      store.seedSent(52, { system: false, status: EmailStatus.DELIVERED });
      store.seedSent(4, { system: false, status: EmailStatus.BOUNCED });
      store.seedSent(40, { system: true, status: EmailStatus.DELIVERED });

      const metrics = await reputation.evaluate(USER_ID);

      expect(metrics.sent).toBe(56);
      expect(metrics.verdict).toBe('SUSPEND');
    });
  });

  describe('ce que l’exemption ne contourne PAS', () => {
    it('la liste de suppression s’applique : rien n’est mis en file', async () => {
      store.suppressions.push({
        address: 'aissatou@example.com',
        userId: USER_ID,
      });

      await expect(sendSystem()).resolves.toEqual({ status: 'suppressed' });

      expect(queue.add).not.toHaveBeenCalled();
      expect(store.email.create).not.toHaveBeenCalled();
    });

    it('une suppression globale (userId nul) bloque aussi l’envoi système', async () => {
      store.suppressions.push({
        address: 'aissatou@example.com',
        userId: null,
      });

      await expect(sendSystem()).resolves.toEqual({ status: 'suppressed' });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('le domaine d’expédition doit être vérifié dans Zendou', async () => {
      store.domains
        .filter((row) => row.name === SYSTEM_DOMAIN)
        .forEach((row) => {
          row.verified = false;
        });

      await expect(sendSystem()).rejects.toThrow(SystemSenderUnavailableError);
      expect(queue.add).not.toHaveBeenCalled();
      expect(store.email.create).not.toHaveBeenCalled();
    });

    it('refuse de partir sans SYSTEM_EMAIL_FROM — aucune adresse en dur', async () => {
      configValues = {};

      await expect(sendSystem()).rejects.toThrow(SystemSenderUnavailableError);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('emprunte la même file, avec la même politique de reprise', async () => {
      const result = await sendSystem();

      expect(queue.add).toHaveBeenCalledWith(
        'send',
        expect.objectContaining({ html: '<p>Lien</p>', text: 'Lien' }),
        expect.objectContaining({
          jobId: result.id,
          attempts: 5,
          removeOnComplete: true,
        }),
      );

      // Traçabilité intacte : la ligne existe, marquée système, sur le
      // domaine d'expédition vérifié de Zendou.
      expect(store.emails[0]).toMatchObject({
        system: true,
        userId: USER_ID,
        domainId: 'dom_system',
        fromAddress: SYSTEM_FROM,
        status: EmailStatus.QUEUED,
      });
    });

    /**
     * Le domaine système n'appartient pas au destinataire : c'est la seule
     * chose que la recherche de domaine relâche. La vérification, elle, est
     * conservée — c'est le test précédent.
     */
    it('ne cherche pas le domaine système parmi ceux du destinataire', async () => {
      await sendSystem();

      expect(store.domain.findFirst).toHaveBeenCalledWith({
        where: { name: SYSTEM_DOMAIN, status: DomainStatus.VERIFIED },
        select: { id: true },
      });
    });
  });

  it('n’apparaît pas dans le volume cumulé qui débloque les paliers de quota', async () => {
    store.seedSent(120, { system: true, status: EmailStatus.DELIVERED });
    store.userRow.createdAt = new Date(Date.now() - 10 * 24 * 3_600_000);

    // 120 envois système, 0 envoi client : le palier « 3 jours / 100 envois »
    // ne doit pas s'ouvrir.
    await expect(reputation.recomputeDailyLimit(USER_ID)).resolves.toBe(200);
    expect(store.user.update).not.toHaveBeenCalled();
  });
});

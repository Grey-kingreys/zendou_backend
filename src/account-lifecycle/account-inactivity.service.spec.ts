import { ConfigService } from '@nestjs/config';
import { UserRole, UserStatus } from '@prisma/client';
import type { DomainsService } from '../domains/domains.service';
import type { EmailsService } from '../emails/emails.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SessionService } from '../auth/session.service';
import { recordAccountActivity } from './account-activity';
import { AccountAnonymizationService } from './account-anonymization.service';
import type { AccountInactivityScheduler } from './account-inactivity.scheduler';
import { AccountInactivityService } from './account-inactivity.service';
import {
  ANONYMIZED_FOR_INACTIVITY_REASON,
  INACTIVITY_WARNING_SUBJECT_PREFIX,
} from './account-lifecycle.constants';
import { InMemoryPrisma } from './fixtures/in-memory-prisma';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Dernière activité le 1er janvier 2026. */
const LAST_ACTIVITY = new Date('2026-01-01T00:00:00.000Z');
/** 23 mois plus tard : seuil de l'avertissement. */
const AT_23_MONTHS = new Date('2027-12-01T00:00:00.000Z');
/** 24 mois plus tard : seuil de l'anonymisation. */
const AT_24_MONTHS = new Date('2028-01-01T00:00:00.000Z');

describe('AccountInactivityService', () => {
  let db: InMemoryPrisma;
  let now: Date;
  let sendSystem: jest.Mock;
  let schedulerStart: jest.Mock;
  let scheduler: AccountInactivityScheduler;
  let service: AccountInactivityService;

  const user = (id: string) => db.tables.user.find((row) => row.id === id)!;

  function seedCustomer(id: string, overrides: Record<string, unknown> = {}) {
    db.seed('user', {
      id,
      email: `${id}@exemple.gn`,
      name: `Client ${id}`,
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      createdAt: new Date('2025-06-01T00:00:00.000Z'),
      lastActivityAt: LAST_ACTIVITY,
      inactivityWarningSentAt: null,
      anonymizedAt: null,
      ...overrides,
    });
    db.seed('creditEntry', { userId: id, delta: 15000, reason: 'TOPUP' });
  }

  beforeEach(() => {
    db = new InMemoryPrisma();
    now = AT_23_MONTHS;
    sendSystem = jest.fn().mockResolvedValue({ status: 'queued', id: 'pub' });
    schedulerStart = jest.fn().mockResolvedValue(undefined);
    scheduler = {
      start: schedulerStart,
      stop: jest.fn().mockResolvedValue(undefined),
    };
    const anonymization = new AccountAnonymizationService(
      db as unknown as PrismaService,
      {
        destroyAllForUser: jest.fn().mockResolvedValue(undefined),
      } as unknown as SessionService,
      {
        deleteSesIdentity: jest.fn().mockResolvedValue(undefined),
      } as unknown as DomainsService,
    );
    service = new AccountInactivityService(
      db as unknown as PrismaService,
      { sendSystem } as unknown as EmailsService,
      anonymization,
      new ConfigService({ APP_BASE_URL: 'https://zendou.app/' }),
      () => now,
      scheduler,
    );
  });

  it('installe la tâche quotidienne au démarrage', async () => {
    await service.onApplicationBootstrap();

    expect(schedulerStart).toHaveBeenCalledTimes(1);
  });

  describe('avertissement', () => {
    it('n’avertit pas avant 23 mois d’inactivité', async () => {
      seedCustomer('c1');
      now = new Date(AT_23_MONTHS.getTime() - DAY_MS);

      await expect(service.runSweep()).resolves.toMatchObject({ warned: 0 });
      expect(sendSystem).not.toHaveBeenCalled();
    });

    it('avertit à 23 mois par le chemin système, avec la date et le lien de connexion', async () => {
      seedCustomer('c1');

      await expect(service.runSweep()).resolves.toMatchObject({ warned: 1 });

      expect(user('c1').inactivityWarningSentAt).toEqual(AT_23_MONTHS);
      expect(sendSystem).toHaveBeenCalledTimes(1);
      const [payload] = sendSystem.mock.calls[0] as [
        { userId: string; to: string; subject: string; text: string },
      ];
      expect(payload.userId).toBe('c1');
      expect(payload.to).toBe('c1@exemple.gn');
      // max(dernière activité + 24 mois, aujourd'hui + 30 jours)
      expect(payload.subject).toBe(
        `${INACTIVITY_WARNING_SUBJECT_PREFIX}1 janvier 2028`,
      );
      expect(payload.text).toContain('https://zendou.app/connexion');
      expect(payload.text).toContain('il suffit de vous connecter');
    });

    it('n’envoie qu’un seul avertissement, même en passant chaque jour', async () => {
      seedCustomer('c1');

      for (let day = 0; day < 20; day += 1) {
        now = new Date(AT_23_MONTHS.getTime() + day * DAY_MS);
        await service.runSweep();
      }

      expect(sendSystem).toHaveBeenCalledTimes(1);
      expect(user('c1').inactivityWarningSentAt).toEqual(AT_23_MONTHS);
    });

    it('retire le marqueur si l’envoi échoue, pour réessayer le lendemain', async () => {
      seedCustomer('c1');
      sendSystem.mockRejectedValueOnce(new Error('SYSTEM_EMAIL_FROM absente'));

      await expect(service.runSweep()).resolves.toMatchObject({ warned: 0 });
      expect(user('c1').inactivityWarningSentAt).toBeNull();

      now = new Date(AT_23_MONTHS.getTime() + DAY_MS);
      await expect(service.runSweep()).resolves.toMatchObject({ warned: 1 });
      expect(sendSystem).toHaveBeenCalledTimes(2);
    });

    it('se rabat sur createdAt quand aucune activité n’est connue, jamais sur « inactif depuis toujours »', async () => {
      seedCustomer('recent', {
        lastActivityAt: null,
        createdAt: new Date('2027-06-01T00:00:00.000Z'),
      });

      await expect(service.runSweep()).resolves.toMatchObject({ warned: 0 });
    });

    it('exclut les ADMIN', async () => {
      seedCustomer('adm', { role: UserRole.ADMIN });

      now = new Date(AT_24_MONTHS.getTime() + 90 * DAY_MS);
      await expect(service.runSweep()).resolves.toMatchObject({
        warned: 0,
        anonymized: 0,
      });
      expect(user('adm').anonymizedAt).toBeNull();
    });
  });

  describe('anonymisation', () => {
    it('n’anonymise pas à 30 jours d’avertissement tant que 24 mois ne sont pas atteints', async () => {
      seedCustomer('c1');
      await service.runSweep(); // avertissement à 23 mois

      now = new Date(AT_23_MONTHS.getTime() + 30 * DAY_MS + 1);
      await expect(service.runSweep()).resolves.toMatchObject({
        anonymized: 0,
      });
      expect(user('c1').anonymizedAt).toBeNull();

      now = AT_24_MONTHS;
      await expect(service.runSweep()).resolves.toMatchObject({
        anonymized: 1,
      });
      expect(user('c1').anonymizedAt).not.toBeNull();
      expect(user('c1').email).toBe('anonymise-c1@anonymise.invalid');
      expect(user('c1').suspensionReason).toBe(
        ANONYMIZED_FOR_INACTIVITY_REASON,
      );
      // Traces de paiement conservées.
      expect(
        db.tables.creditEntry.filter((row) => row.userId === 'c1'),
      ).toHaveLength(1);
    });

    it('n’anonymise pas à 24 mois tant que 30 jours d’avertissement ne sont pas écoulés', async () => {
      seedCustomer('c1');
      now = AT_24_MONTHS;
      await expect(service.runSweep()).resolves.toMatchObject({
        warned: 1,
        anonymized: 0,
      });

      now = new Date(AT_24_MONTHS.getTime() + 29 * DAY_MS);
      await expect(service.runSweep()).resolves.toMatchObject({
        anonymized: 0,
      });

      now = new Date(AT_24_MONTHS.getTime() + 30 * DAY_MS);
      await expect(service.runSweep()).resolves.toMatchObject({
        anonymized: 1,
      });
    });

    it('avertissement tardif : 30 jours d’attente même au-delà de 24 mois', async () => {
      seedCustomer('c1');
      now = new Date(AT_24_MONTHS.getTime() + 60 * DAY_MS);

      await expect(service.runSweep()).resolves.toMatchObject({
        warned: 1,
        anonymized: 0,
      });
      const [payload] = sendSystem.mock.calls[0] as [{ subject: string }];
      expect(payload.subject).toBe(
        `${INACTIVITY_WARNING_SUBJECT_PREFIX}31 mars 2028`,
      );

      now = new Date(now.getTime() + 29 * DAY_MS);
      await expect(service.runSweep()).resolves.toMatchObject({
        anonymized: 0,
      });
      now = new Date(now.getTime() + DAY_MS);
      await expect(service.runSweep()).resolves.toMatchObject({
        anonymized: 1,
      });
    });

    it('épargne un compte redevenu actif après l’avertissement, et lève son marqueur', async () => {
      seedCustomer('c1');
      await service.runSweep();
      expect(user('c1').inactivityWarningSentAt).not.toBeNull();

      // Connexion 10 jours après l'avertissement.
      await recordAccountActivity(
        db,
        'c1',
        new Date(AT_23_MONTHS.getTime() + 10 * DAY_MS),
      );

      now = new Date(AT_24_MONTHS.getTime() + 60 * DAY_MS);
      await expect(service.runSweep()).resolves.toMatchObject({
        anonymized: 0,
      });
      expect(user('c1').anonymizedAt).toBeNull();
      expect(user('c1').inactivityWarningSentAt).toBeNull();
    });

    it('lève au passage suivant le marqueur d’un compte redevenu actif par un autre chemin', async () => {
      seedCustomer('c1');
      await service.runSweep();
      // Activité écrite sans levée du marqueur (course avec le passage).
      user('c1').lastActivityAt = new Date(AT_23_MONTHS.getTime() + DAY_MS);

      now = new Date(AT_23_MONTHS.getTime() + 2 * DAY_MS);
      await expect(service.runSweep()).resolves.toMatchObject({
        warningsLifted: 1,
        warned: 0,
      });
      expect(user('c1').inactivityWarningSentAt).toBeNull();
    });

    it('ne rend jamais la main en erreur : un compte en échec n’arrête pas les autres', async () => {
      seedCustomer('c1');
      seedCustomer('c2');
      await service.runSweep();
      const anonymize = jest
        .spyOn(AccountAnonymizationService.prototype, 'anonymize')
        .mockRejectedValueOnce(new Error('panne'));

      now = new Date(AT_24_MONTHS.getTime() + 31 * DAY_MS);
      await expect(service.runSweep()).resolves.toMatchObject({
        anonymized: 1,
      });
      anonymize.mockRestore();
    });
  });
});

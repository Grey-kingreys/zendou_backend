import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { DomainStatus, EmailStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import type { SendEmailDto } from './dto/send-email.dto';
import {
  BODY_TOO_LARGE_MESSAGE,
  CREDIT_REASON_SEND,
  DAILY_LIMIT_REACHED_MESSAGE,
  DOMAIN_NOT_VERIFIED_MESSAGE,
  EMAIL_SEND_JOB,
  FAILED_EMAIL_JOB_RETENTION_SECONDS,
  INSUFFICIENT_CREDITS_MESSAGE,
  INVALID_FROM_MESSAGE,
  INVALID_REPLY_TO_MESSAGE,
  INVALID_TO_MESSAGE,
  MISSING_BODY_MESSAGE,
  REPLY_TO_NOT_VERIFIED_MESSAGE,
  SEND_JOB_ATTEMPTS,
  SEND_JOB_BACKOFF_DELAY_MS,
  SEND_REFUSAL,
  TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE,
  TEST_SENDER_UNAVAILABLE_MESSAGE,
} from './emails.constants';
import {
  EmailsService,
  secondsUntilNextUtcDay,
  sendRefusalReason,
  startOfUtcDay,
} from './emails.service';

const USER_ID = 'user_1';
const DOMAIN_ID = 'dom_1';

function dtoWith(overrides: Partial<SendEmailDto> = {}): SendEmailDto {
  return {
    from: 'Awa Diallo <contact@boutique-awa.gn>',
    to: 'client@exemple.gn',
    subject: 'Votre commande est prête',
    html: '<p>Bonjour</p>',
    ...overrides,
  };
}

interface EmailCreateArgs {
  data: {
    publicId: string;
    userId: string;
    domainId: string | null;
    fromAddress: string;
    toAddress: string;
    subject: string;
    status: EmailStatus;
    system?: boolean;
  };
}

describe('EmailsService', () => {
  let service: EmailsService;
  let capturedEmailCreate: EmailCreateArgs | undefined;

  const domain = { findFirst: jest.fn() };
  const suppression = { findFirst: jest.fn() };
  const creditEntry = {
    aggregate: jest.fn(),
    create: jest.fn(),
    findFirst: jest.fn(),
  };
  const email = { create: jest.fn(), count: jest.fn() };
  const user = { findUnique: jest.fn(), updateMany: jest.fn() };
  const queue = { add: jest.fn() };

  /** Configuration des envois système ; réglée par test. */
  let configValues: Record<string, string> = {};
  const config = {
    get: (key: string): string | undefined => configValues[key],
  } as unknown as ConfigService;

  const prisma = {
    domain,
    suppression,
    creditEntry,
    email,
    user,
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedEmailCreate = undefined;
    configValues = { SYSTEM_EMAIL_FROM: 'Zendou <no-reply@mail.kingreys.fr>' };

    // Chemin nominal : domaine vérifié, pas de suppression, crédits et
    // quota disponibles. Chaque test ne dérègle que ce qu'il éprouve.
    domain.findFirst.mockResolvedValue({ id: DOMAIN_ID });
    suppression.findFirst.mockResolvedValue(null);
    creditEntry.aggregate.mockResolvedValue({ _sum: { delta: 10 } });
    creditEntry.create.mockResolvedValue({ id: 'credit_1' });
    creditEntry.findFirst.mockResolvedValue(null);
    email.count.mockResolvedValue(0);
    user.findUnique.mockResolvedValue({
      dailySendLimit: 200,
      email: 'aissatou@exemple.gn',
    });
    email.create.mockImplementation((args: EmailCreateArgs) => {
      capturedEmailCreate = args;
      return Promise.resolve({ id: 'email_1', publicId: args.data.publicId });
    });
    queue.add.mockResolvedValue({ id: 'job_1' });
    user.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(
      (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailsService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken(EMAIL_SEND_QUEUE), useValue: queue },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(EmailsService);
  });

  /**
   * ANON-1 : un envoi client accepté est une activité du titulaire. Au plus
   * une écriture par heure : une activité connue de moins d'une heure ne
   * coûte aucune requête.
   */
  describe('activité du compte', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const HOUR_MS = 60 * 60 * 1000;

    it('enregistre l’activité après un envoi accepté quand elle date de plus d’une heure', async () => {
      user.findUnique.mockResolvedValue({
        dailySendLimit: 200,
        email: 'aissatou@exemple.gn',
        lastActivityAt: new Date(Date.now() - 2 * HOUR_MS),
      });

      await service.send(USER_ID, dtoWith());
      await flush();

      expect(user.updateMany).toHaveBeenCalledTimes(1);
      const [args] = user.updateMany.mock.calls[0] as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ];
      expect(args.where).toMatchObject({ id: USER_ID, anonymizedAt: null });
      expect(args.data.lastActivityAt).toBeInstanceOf(Date);
      expect(args.data.inactivityWarningSentAt).toBeNull();
    });

    it('n’écrit rien quand l’activité connue a moins d’une heure', async () => {
      user.findUnique.mockResolvedValue({
        dailySendLimit: 200,
        email: 'aissatou@exemple.gn',
        lastActivityAt: new Date(Date.now() - 30 * 60 * 1000),
      });

      await service.send(USER_ID, dtoWith());
      await flush();

      expect(user.updateMany).not.toHaveBeenCalled();
    });

    it('enregistre aussi un envoi accepté vers une adresse supprimée', async () => {
      suppression.findFirst.mockResolvedValue({ id: 'sup_1' });

      await service.send(USER_ID, dtoWith());
      await flush();

      expect(user.updateMany).toHaveBeenCalledTimes(1);
    });

    it('n’enregistre rien pour un envoi refusé', async () => {
      await expect(
        service.send(USER_ID, dtoWith({ from: 'pas-un-email' })),
      ).rejects.toThrow(BadRequestException);
      await flush();

      expect(user.updateMany).not.toHaveBeenCalled();
    });

    it('un échec d’écriture ne remet pas l’envoi en cause', async () => {
      user.updateMany.mockRejectedValue(new Error('base indisponible'));

      await expect(service.send(USER_ID, dtoWith())).resolves.toMatchObject({
        status: 'queued',
      });
      await flush();
    });
  });

  /**
   * Alerte de solde bas : un email système au titulaire quand un débit fait
   * passer le solde sous 10 % du solde atteint après le dernier crédit positif
   * (plancher 50), une seule fois par passage, sans jamais gêner l'envoi.
   */
  describe('alerte de solde bas', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const LAST_CREDIT_AT = new Date('2026-10-01T10:00:00.000Z');
    let sendSystem: jest.SpyInstance;

    /** État du grand livre : solde juste après le dernier crédit, solde actuel. */
    function givenLedger(options: {
      afterCredit: number;
      current: number;
      alertSentAt?: Date | null;
    }): void {
      creditEntry.findFirst.mockResolvedValue({ createdAt: LAST_CREDIT_AT });
      // `current` est le solde après le débit. La première somme complète est
      // celle d'`assertSufficientCredits`, lue avant le débit (1 de plus).
      let fullSums = 0;
      creditEntry.aggregate.mockImplementation(
        ({ where }: { where: { createdAt?: unknown } }) => {
          if (where.createdAt) {
            return Promise.resolve({ _sum: { delta: options.afterCredit } });
          }
          fullSums += 1;
          return Promise.resolve({
            _sum: { delta: options.current + (fullSums === 1 ? 1 : 0) },
          });
        },
      );
      user.findUnique.mockResolvedValue({
        dailySendLimit: 200,
        email: 'aissatou@exemple.gn',
        name: 'Aïssatou',
        lowBalanceAlertSentAt: options.alertSentAt ?? null,
      });
    }

    beforeEach(() => {
      configValues.APP_BASE_URL = 'https://zendou.app/';
      sendSystem = jest
        .spyOn(service, 'sendSystem')
        .mockResolvedValue({ status: 'queued', id: 'e_alerte' });
    });

    it('envoie un email système au titulaire quand le solde passe sous 10 %', async () => {
      givenLedger({ afterCredit: 1000, current: 99 });

      await expect(service.send(USER_ID, dtoWith())).resolves.toMatchObject({
        status: 'queued',
      });
      await flush();

      expect(sendSystem).toHaveBeenCalledTimes(1);
      const [payload] = sendSystem.mock.calls[0] as [
        { userId: string; to: string; subject: string; text: string },
      ];
      expect(payload.userId).toBe(USER_ID);
      expect(payload.to).toBe('aissatou@exemple.gn');
      expect(payload.text).toContain('Il vous reste 99 crédits');
      expect(payload.text).toContain('402');
      expect(payload.text).toContain(
        'https://zendou.app/dashboard/facturation',
      );
      expect(user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { lowBalanceAlertSentAt: expect.any(Date) as Date },
        }),
      );
    });

    it('ne fait rien tant que le solde reste au seuil ou au-dessus', async () => {
      givenLedger({ afterCredit: 1000, current: 100 });

      await service.send(USER_ID, dtoWith());
      await flush();

      expect(sendSystem).not.toHaveBeenCalled();
    });

    it('coûte peu sur le chemin courant : pas de solde relu, pas de lecture du compte', async () => {
      givenLedger({ afterCredit: 1000, current: 500 });
      user.findUnique.mockClear();

      await service.send(USER_ID, dtoWith());
      await flush();

      // assertSufficientCredits + la somme jusqu'au dernier crédit, rien de plus.
      expect(creditEntry.aggregate).toHaveBeenCalledTimes(2);
      expect(creditEntry.findFirst).toHaveBeenCalledTimes(1);
      // Compte (assertAccountMaySend) et quota seulement : pas de relecture pour l'alerte.
      expect(user.findUnique).toHaveBeenCalledTimes(2);
      expect(sendSystem).not.toHaveBeenCalled();
    });

    it('sort dès le marqueur quand le compte est déjà alerté : aucune somme de plus', async () => {
      givenLedger({
        afterCredit: 1000,
        current: 20,
        alertSentAt: new Date('2026-10-05T10:00:00.000Z'),
      });

      await service.send(USER_ID, dtoWith());
      await flush();

      // Seule la somme d'assertSufficientCredits.
      expect(creditEntry.aggregate).toHaveBeenCalledTimes(1);
    });

    it('relit le solde exact avant d’alerter : un crédit arrivé entre-temps annule l’alerte', async () => {
      givenLedger({ afterCredit: 1000, current: 80 });
      let fullSums = 0;
      creditEntry.aggregate.mockImplementation(
        ({ where }: { where: { createdAt?: unknown } }) => {
          if (where.createdAt) {
            return Promise.resolve({ _sum: { delta: 1000 } });
          }
          fullSums += 1;
          // Avant le débit : 81 ; au moment de relire : un crédit est passé.
          return Promise.resolve({
            _sum: { delta: fullSums === 1 ? 81 : 500 },
          });
        },
      );

      await service.send(USER_ID, dtoWith());
      await flush();

      expect(sendSystem).not.toHaveBeenCalled();
    });

    it('ne fait rien sans aucun crédit positif', async () => {
      creditEntry.findFirst.mockResolvedValue(null);

      await service.send(USER_ID, dtoWith());
      await flush();

      expect(sendSystem).not.toHaveBeenCalled();
    });

    it("n'envoie qu'une alerte par passage : déjà alerté depuis le dernier crédit", async () => {
      givenLedger({
        afterCredit: 1000,
        current: 80,
        alertSentAt: new Date('2026-10-05T10:00:00.000Z'),
      });

      await service.send(USER_ID, dtoWith());
      await flush();

      expect(sendSystem).not.toHaveBeenCalled();
    });

    it('se réarme au crédit positif suivant', async () => {
      givenLedger({
        afterCredit: 1000,
        current: 80,
        // Alerte antérieure au dernier crédit : un nouveau passage.
        alertSentAt: new Date('2026-09-20T10:00:00.000Z'),
      });

      await service.send(USER_ID, dtoWith());
      await flush();

      expect(sendSystem).toHaveBeenCalledTimes(1);
      // La prise du marqueur n'est permise que si l'alerte précédente est
      // plus ancienne que le dernier crédit.
      expect(user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { lowBalanceAlertSentAt: null },
              { lowBalanceAlertSentAt: { lt: LAST_CREDIT_AT } },
            ],
          }) as unknown,
        }),
      );
    });

    it("n'envoie rien quand un envoi concurrent a déjà pris le marqueur", async () => {
      givenLedger({ afterCredit: 1000, current: 80 });
      user.updateMany.mockResolvedValue({ count: 0 });

      await service.send(USER_ID, dtoWith());
      await flush();

      expect(sendSystem).not.toHaveBeenCalled();
    });

    it('applique le plancher de 50 crédits quand 10 % en font moins', async () => {
      // 10 % de 200 = 20, mais le seuil est 50.
      givenLedger({ afterCredit: 200, current: 30 });
      await service.send(USER_ID, dtoWith());
      await flush();
      expect(sendSystem).toHaveBeenCalledTimes(1);

      sendSystem.mockClear();
      givenLedger({ afterCredit: 200, current: 50 });
      await service.send(USER_ID, dtoWith());
      await flush();
      expect(sendSystem).not.toHaveBeenCalled();
    });

    it('couvre aussi les débits du relais SMTP', async () => {
      givenLedger({ afterCredit: 1000, current: 99 });

      await service.acceptSmtp(USER_ID, {
        from: 'contact@boutique-awa.gn',
        to: 'client@exemple.gn',
        subject: 'Bonjour',
        raw: 'From: contact@boutique-awa.gn\r\n\r\nBonjour',
        smtpCredentialId: 'smtp_1',
      });
      await flush();

      expect(sendSystem).toHaveBeenCalledTimes(1);
    });

    it('un envoi système ne débite pas et ne déclenche rien', async () => {
      givenLedger({ afterCredit: 1000, current: 10 });
      sendSystem.mockRestore();
      domain.findFirst.mockResolvedValue({ id: DOMAIN_ID });

      await service.sendSystem({
        userId: USER_ID,
        to: 'aissatou@exemple.gn',
        subject: 'Bonjour',
        text: 'Bonjour',
      });
      await flush();

      expect(creditEntry.create).not.toHaveBeenCalled();
      expect(creditEntry.findFirst).not.toHaveBeenCalled();
    });

    it("un échec de l'alerte ne fait pas échouer l'envoi et lève le marqueur", async () => {
      givenLedger({ afterCredit: 1000, current: 80 });
      sendSystem.mockRejectedValue(new Error('SYSTEM_EMAIL_FROM absente'));

      await expect(service.send(USER_ID, dtoWith())).resolves.toMatchObject({
        status: 'queued',
      });
      await flush();

      // Prise du marqueur, puis restitution : le prochain débit retentera.
      const calls = user.updateMany.mock.calls as [
        { data: { lowBalanceAlertSentAt: unknown } },
      ][];
      expect(
        calls.some(([args]) => args.data.lowBalanceAlertSentAt === null),
      ).toBe(true);
    });

    it('une panne de lecture du grand livre ne fait pas échouer l’envoi', async () => {
      creditEntry.findFirst.mockRejectedValue(new Error('base indisponible'));

      await expect(service.send(USER_ID, dtoWith())).resolves.toMatchObject({
        status: 'queued',
      });
      await flush();
    });
  });

  describe('validation', () => {
    it('rejects an unparseable sender', async () => {
      await expect(
        service.send(USER_ID, dtoWith({ from: 'pas-un-email' })),
      ).rejects.toThrow(new BadRequestException(INVALID_FROM_MESSAGE));

      expect(email.create).not.toHaveBeenCalled();
    });

    it('rejects an unparseable recipient', async () => {
      await expect(
        service.send(USER_ID, dtoWith({ to: 'client@localhost' })),
      ).rejects.toThrow(new BadRequestException(INVALID_TO_MESSAGE));
    });

    it('rejects a message with neither html nor text', async () => {
      await expect(
        service.send(USER_ID, dtoWith({ html: undefined, text: '   ' })),
      ).rejects.toThrow(new BadRequestException(MISSING_BODY_MESSAGE));
    });

    it('rejects a body over 500 Ko', async () => {
      await expect(
        service.send(USER_ID, dtoWith({ html: 'a'.repeat(500 * 1024 + 1) })),
      ).rejects.toThrow(new BadRequestException(BODY_TOO_LARGE_MESSAGE));
    });

    it('accepts a bare sender address', async () => {
      await service.send(
        USER_ID,
        dtoWith({
          from: 'contact@boutique-awa.gn',
          html: undefined,
          text: 'Bonjour',
        }),
      );

      const args = capturedEmailCreate!;
      expect(args.data.fromAddress).toBe('contact@boutique-awa.gn');
    });
  });

  describe('sending domain', () => {
    it('only looks for a VERIFIED domain owned by the caller', async () => {
      await service.send(USER_ID, dtoWith());

      expect(domain.findFirst).toHaveBeenCalledWith({
        where: {
          name: 'boutique-awa.gn',
          userId: USER_ID,
          status: DomainStatus.VERIFIED,
        },
        select: { id: true },
      });
    });

    it('refuses an unverified or foreign domain with a 403', async () => {
      domain.findFirst.mockResolvedValue(null);

      await expect(service.send(USER_ID, dtoWith())).rejects.toThrow(
        new ForbiddenException(DOMAIN_NOT_VERIFIED_MESSAGE),
      );

      expect(email.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  /**
   * Mode bac à sable (B20) : `TEST_EMAIL_FROM` permet d'envoyer sans domaine
   * vérifié, mais uniquement vers l'adresse du compte appelant. C'est la
   * seule chose qui protège la réputation du domaine d'expédition partagé —
   * le même qui expédie les confirmations d'inscription.
   */
  describe('test sending address (sandbox mode)', () => {
    const TEST_FROM = 'Zendou <essai@mail.kingreys.fr>';
    const OWN_EMAIL = 'aissatou@exemple.gn';

    beforeEach(() => {
      configValues = { ...configValues, TEST_EMAIL_FROM: TEST_FROM };
      user.findUnique.mockResolvedValue({
        dailySendLimit: 200,
        email: OWN_EMAIL,
      });
    });

    it('accepts a send to the caller’s own confirmed address, checking only that the test domain is verified — never ownership', async () => {
      const result = await service.send(
        USER_ID,
        dtoWith({ from: TEST_FROM, to: OWN_EMAIL }),
      );

      expect(result.status).toBe('queued');
      // V11C : le domaine de TEST_EMAIL_FROM est bien consulté (sinon une
      // config cassée ne serait détectée qu'à l'envoi SES), mais sans
      // `userId` — ce domaine appartient à Zendou, pas au client.
      expect(domain.findFirst).toHaveBeenCalledWith({
        where: { name: 'mail.kingreys.fr', status: DomainStatus.VERIFIED },
        select: { id: true },
      });

      const args = capturedEmailCreate!;
      expect(args.data.domainId).toBeNull();
      expect(args.data).toMatchObject({
        fromAddress: TEST_FROM,
        toAddress: OWN_EMAIL,
        status: EmailStatus.QUEUED,
      });
    });

    it('does not record it as a system send — it is an ordinary client send', async () => {
      await service.send(USER_ID, dtoWith({ from: TEST_FROM, to: OWN_EMAIL }));

      const args = capturedEmailCreate!;
      expect(args.data).toMatchObject({ system: false });
    });

    it('still debits one credit, like any other send', async () => {
      await service.send(USER_ID, dtoWith({ from: TEST_FROM, to: OWN_EMAIL }));

      const emailArgs = capturedEmailCreate!;
      expect(creditEntry.create).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          delta: -1,
          reason: CREDIT_REASON_SEND,
          reference: emailArgs.data.publicId,
        },
      });
    });

    it('recognises the address regardless of the display name used', async () => {
      const result = await service.send(
        USER_ID,
        dtoWith({
          from: `Ma Boutique <${'essai@mail.kingreys.fr'}>`,
          to: OWN_EMAIL,
        }),
      );

      expect(result.status).toBe('queued');
      expect(domain.findFirst).toHaveBeenCalledWith({
        where: { name: 'mail.kingreys.fr', status: DomainStatus.VERIFIED },
        select: { id: true },
      });
    });

    it('refuses any recipient other than the caller’s own address, with a 403 that explains the mode', async () => {
      await expect(
        service.send(
          USER_ID,
          dtoWith({ from: TEST_FROM, to: 'quelquun-dautre@exemple.gn' }),
        ),
      ).rejects.toThrow(
        new ForbiddenException(TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE),
      );
    });

    it('debits no credit and creates no email row when the recipient is refused', async () => {
      await expect(
        service.send(
          USER_ID,
          dtoWith({ from: TEST_FROM, to: 'quelquun-dautre@exemple.gn' }),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(email.create).not.toHaveBeenCalled();
      expect(creditEntry.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      // Le contrôle du destinataire est au même endroit que l'ancien contrôle
      // de domaine, avant tout autre effet de bord : ni suppression, ni
      // solde, ni quota ne sont même consultés.
      expect(suppression.findFirst).not.toHaveBeenCalled();
      expect(creditEntry.aggregate).not.toHaveBeenCalled();
    });

    it('compares addresses case-insensitively', async () => {
      const result = await service.send(
        USER_ID,
        dtoWith({ from: TEST_FROM, to: OWN_EMAIL.toUpperCase() }),
      );

      expect(result.status).toBe('queued');
    });

    it('leaves an ordinary send from a verified domain unaffected (non-regression)', async () => {
      const result = await service.send(USER_ID, dtoWith());

      expect(result.status).toBe('queued');
      expect(domain.findFirst).toHaveBeenCalledWith({
        where: {
          name: 'boutique-awa.gn',
          userId: USER_ID,
          status: DomainStatus.VERIFIED,
        },
        select: { id: true },
      });

      const args = capturedEmailCreate!;
      expect(args.data.domainId).toBe(DOMAIN_ID);
    });

    it('treats an unconfigured TEST_EMAIL_FROM as no sandbox at all — falls back to the domain check', async () => {
      configValues = { SYSTEM_EMAIL_FROM: configValues.SYSTEM_EMAIL_FROM };
      domain.findFirst.mockResolvedValue(null);

      await expect(
        service.send(
          USER_ID,
          dtoWith({ from: 'essai@mail.kingreys.fr', to: 'anyone@exemple.gn' }),
        ),
      ).rejects.toThrow(new ForbiddenException(DOMAIN_NOT_VERIFIED_MESSAGE));

      expect(email.create).not.toHaveBeenCalled();
    });
  });

  /**
   * V11C : le domaine de `TEST_EMAIL_FROM` doit être `VERIFIED` dans Zendou
   * pour que le mode bac à sable accepte un envoi — même exigence que
   * `sendSystem` pour `SYSTEM_EMAIL_FROM`. Sans ce contrôle, une mauvaise
   * configuration (domaine absent ou encore `PENDING`) ne serait détectée
   * qu'à l'envoi SES, après que le client ait déjà payé un crédit pour un
   * email qui ne partira jamais.
   */
  describe('test sending address — domain verification (V11C)', () => {
    const TEST_FROM = 'Zendou <essai@mail.kingreys.fr>';
    const OWN_EMAIL = 'aissatou@exemple.gn';

    beforeEach(() => {
      configValues = { ...configValues, TEST_EMAIL_FROM: TEST_FROM };
      user.findUnique.mockResolvedValue({
        dailySendLimit: 200,
        email: OWN_EMAIL,
      });
    });

    it('refuses with a 503 when the test domain is absent from Domain, and debits no credit', async () => {
      domain.findFirst.mockResolvedValue(null);

      await expect(
        service.send(USER_ID, dtoWith({ from: TEST_FROM, to: OWN_EMAIL })),
      ).rejects.toThrow(
        new ServiceUnavailableException(TEST_SENDER_UNAVAILABLE_MESSAGE),
      );

      expect(domain.findFirst).toHaveBeenCalledWith({
        where: { name: 'mail.kingreys.fr', status: DomainStatus.VERIFIED },
        select: { id: true },
      });
      // Le refus se produit avant tout autre effet de bord : ni email tracé,
      // ni crédit débité (même le solde n'est pas consulté), ni job en file.
      expect(email.create).not.toHaveBeenCalled();
      expect(creditEntry.create).not.toHaveBeenCalled();
      expect(creditEntry.aggregate).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('refuses with the same 503 when the test domain exists but is only PENDING', async () => {
      // La requête filtre sur `status: VERIFIED` (voir l'assertion
      // ci-dessus) : un domaine encore `PENDING` ne matche jamais cette
      // requête, donc `findFirst` renvoie `null` — exactement comme un
      // domaine absent. C'est la même ligne de code qui refuse les deux cas ;
      // la preuve contre une vraie base (scratchpad/) insère un domaine
      // `PENDING` en base pour lever toute ambiguïté sur le mock.
      domain.findFirst.mockResolvedValue(null);

      await expect(
        service.send(USER_ID, dtoWith({ from: TEST_FROM, to: OWN_EMAIL })),
      ).rejects.toThrow(
        new ServiceUnavailableException(TEST_SENDER_UNAVAILABLE_MESSAGE),
      );

      expect(creditEntry.create).not.toHaveBeenCalled();
    });

    it('accepts the send once the test domain is VERIFIED (non-regression)', async () => {
      domain.findFirst.mockResolvedValue({ id: 'dom_test' });

      const result = await service.send(
        USER_ID,
        dtoWith({ from: TEST_FROM, to: OWN_EMAIL }),
      );

      expect(result.status).toBe('queued');
      expect(creditEntry.create).toHaveBeenCalled();
    });
  });

  describe('suppression list', () => {
    it('records a SUPPRESSED email without charging or queueing it', async () => {
      suppression.findFirst.mockResolvedValue({ id: 'sup_1' });

      const result = await service.send(USER_ID, dtoWith());

      expect(result.status).toBe('suppressed');
      expect(result.id).toMatch(/^e_[0-9a-f]{12}$/);

      const args = capturedEmailCreate!;
      expect(args.data.status).toBe(EmailStatus.SUPPRESSED);
      expect(creditEntry.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('matches both the caller entries and the global ones', async () => {
      await service.send(USER_ID, dtoWith());

      expect(suppression.findFirst).toHaveBeenCalledWith({
        where: {
          address: 'client@exemple.gn',
          OR: [{ userId: USER_ID }, { userId: null }],
        },
        select: { id: true },
      });
    });
  });

  describe('credits', () => {
    it('refuses with a 402 when the balance is empty', async () => {
      creditEntry.aggregate.mockResolvedValue({ _sum: { delta: 0 } });

      await expect(service.send(USER_ID, dtoWith())).rejects.toThrow(
        new HttpException(
          INSUFFICIENT_CREDITS_MESSAGE,
          HttpStatus.PAYMENT_REQUIRED,
        ),
      );

      expect(email.create).not.toHaveBeenCalled();
      expect(creditEntry.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('treats a client with no credit entry at all as empty', async () => {
      creditEntry.aggregate.mockResolvedValue({ _sum: { delta: null } });

      await expect(service.send(USER_ID, dtoWith())).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
      });
    });
  });

  describe('daily limit', () => {
    it('refuses with a 429 once the quota is reached, before any debit', async () => {
      email.count.mockResolvedValue(200);

      await expect(service.send(USER_ID, dtoWith())).rejects.toThrow(
        new HttpException(
          DAILY_LIMIT_REACHED_MESSAGE,
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );

      expect(email.create).not.toHaveBeenCalled();
      expect(creditEntry.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('counts the emails created since UTC midnight, system sends excluded', async () => {
      await service.send(USER_ID, dtoWith());

      expect(email.count).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
          system: false,
          queuedAt: { gte: startOfUtcDay(new Date()) },
        },
      });
    });

    it('still accepts the send one below the quota', async () => {
      email.count.mockResolvedValue(199);

      await expect(service.send(USER_ID, dtoWith())).resolves.toMatchObject({
        status: 'queued',
      });
    });
  });

  describe('accepted send', () => {
    it('creates the email and debits one credit in the same transaction', async () => {
      const result = await service.send(USER_ID, dtoWith());

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      const args = capturedEmailCreate!;
      expect(args.data).toMatchObject({
        userId: USER_ID,
        domainId: DOMAIN_ID,
        fromAddress: 'Awa Diallo <contact@boutique-awa.gn>',
        toAddress: 'client@exemple.gn',
        subject: 'Votre commande est prête',
        status: EmailStatus.QUEUED,
      });
      expect(args.data.publicId).toMatch(/^e_[0-9a-f]{12}$/);

      expect(creditEntry.create).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          delta: -1,
          reason: CREDIT_REASON_SEND,
          reference: args.data.publicId,
        },
      });

      expect(result).toEqual({ id: args.data.publicId, status: 'queued' });
    });

    it('enqueues the job with the public id and the retry policy', async () => {
      const result = await service.send(USER_ID, dtoWith({ text: 'Bonjour' }));

      expect(queue.add).toHaveBeenCalledWith(
        EMAIL_SEND_JOB,
        { emailId: 'email_1', html: '<p>Bonjour</p>', text: 'Bonjour' },
        {
          jobId: result.id,
          attempts: SEND_JOB_ATTEMPTS,
          backoff: { type: 'exponential', delay: SEND_JOB_BACKOFF_DELAY_MS },
          removeOnComplete: true,
          removeOnFail: { age: FAILED_EMAIL_JOB_RETENTION_SECONDS },
        },
      );
    });

    it('enqueues only after the transaction has committed', async () => {
      const order: string[] = [];

      prisma.$transaction.mockImplementation(
        async (run: (tx: typeof prisma) => Promise<unknown>) => {
          const value = await run(prisma);
          order.push('commit');
          return value;
        },
      );
      queue.add.mockImplementation(() => {
        order.push('enqueue');
        return Promise.resolve({ id: 'job_1' });
      });

      await service.send(USER_ID, dtoWith());

      expect(order).toEqual(['commit', 'enqueue']);
    });

    it('draws a distinct public id for each send', async () => {
      const first = await service.send(USER_ID, dtoWith());
      const second = await service.send(USER_ID, dtoWith());

      expect(first.id).not.toBe(second.id);
    });
  });
});

/**
 * E1 - usurpation de l'expéditeur.
 *
 * Trois propriétés, éprouvées contre un `domain.findFirst` qui **filtre pour de
 * bon** (nom exact, propriétaire, statut) : sans cela, un test de sous-domaine
 * ne prouverait rien - un mock à réponse unique dirait « trouvé » quel que soit
 * le nom demandé.
 */
describe('EmailsService - expéditeur, adresse de réponse et codes de refus (E1)', () => {
  let service: EmailsService;
  let capturedEmailCreate: EmailCreateArgs | undefined;

  const domain = { findFirst: jest.fn() };
  const suppression = { findFirst: jest.fn() };
  const creditEntry = {
    aggregate: jest.fn(),
    create: jest.fn(),
    findFirst: jest.fn(),
  };
  const email = { create: jest.fn(), count: jest.fn() };
  const user = { findUnique: jest.fn() };
  const queue = { add: jest.fn() };

  let configValues: Record<string, string> = {};

  const prisma = {
    domain,
    suppression,
    creditEntry,
    email,
    user,
    $transaction: jest.fn(),
  };

  /** Domaines `VERIFIED` du compte appelant, comparés au nom **exact**. */
  function givenVerifiedDomains(...names: string[]): void {
    domain.findFirst.mockImplementation(
      ({
        where,
      }: {
        where: { name: string; userId?: string; status: DomainStatus };
      }) =>
        Promise.resolve(
          names.includes(where.name) &&
            where.status === DomainStatus.VERIFIED &&
            (where.userId === undefined || where.userId === USER_ID)
            ? { id: DOMAIN_ID }
            : null,
        ),
    );
  }

  /** Corps HTTP réellement rendu par un refus (celui que le filtre recopie). */
  async function refusalBodyOf(
    call: Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      await call;
    } catch (error: unknown) {
      return (error as HttpException).getResponse() as Record<string, unknown>;
    }

    throw new Error('l’envoi aurait dû être refusé');
  }

  /** L'envoi n'a rien laissé derrière lui : ni ligne, ni débit, ni job. */
  function expectNoSideEffect(): void {
    expect(email.create).not.toHaveBeenCalled();
    expect(creditEntry.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedEmailCreate = undefined;
    configValues = { SYSTEM_EMAIL_FROM: 'Zendou <no-reply@mail.kingreys.fr>' };

    givenVerifiedDomains('boutique-awa.gn');
    suppression.findFirst.mockResolvedValue(null);
    creditEntry.aggregate.mockResolvedValue({ _sum: { delta: 10 } });
    creditEntry.create.mockResolvedValue({ id: 'credit_1' });
    creditEntry.findFirst.mockResolvedValue(null);
    email.count.mockResolvedValue(0);
    user.findUnique.mockResolvedValue({
      dailySendLimit: 200,
      email: 'aissatou@exemple.gn',
    });
    email.create.mockImplementation((args: EmailCreateArgs) => {
      capturedEmailCreate = args;
      return Promise.resolve({ id: 'email_1', publicId: args.data.publicId });
    });
    queue.add.mockResolvedValue({ id: 'job_1' });
    prisma.$transaction.mockImplementation(
      (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailsService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken(EMAIL_SEND_QUEUE), useValue: queue },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => configValues[key] },
        },
      ],
    }).compile();

    service = module.get(EmailsService);
  });

  // ─── (a) sous-domaines : l'égalité du nom est stricte ────────────────────
  describe('(a) un sous-domaine est un domaine à part entière', () => {
    it('refuse en 403 DOMAIN_NOT_VERIFIED un From sur un sous-domaine du domaine vérifié', async () => {
      givenVerifiedDomains('exemple.gn');

      const body = await refusalBodyOf(
        service.send(USER_ID, dtoWith({ from: 'noreply@mail.exemple.gn' })),
      );

      expect(body).toMatchObject({
        statusCode: HttpStatus.FORBIDDEN,
        code: SEND_REFUSAL.DOMAIN_NOT_VERIFIED,
        message: DOMAIN_NOT_VERIFIED_MESSAGE,
      });
      // La requête a bien porté sur le nom complet : rien n'a « remonté »
      // vers le domaine parent.
      expect(domain.findFirst).toHaveBeenCalledWith({
        where: {
          name: 'mail.exemple.gn',
          userId: USER_ID,
          status: DomainStatus.VERIFIED,
        },
        select: { id: true },
      });
      expectNoSideEffect();
    });

    it('refuse aussi l’inverse : sous-domaine vérifié, From sur le domaine parent', async () => {
      givenVerifiedDomains('mail.exemple.gn');

      const body = await refusalBodyOf(
        service.send(USER_ID, dtoWith({ from: 'contact@exemple.gn' })),
      );

      expect(body).toMatchObject({
        statusCode: HttpStatus.FORBIDDEN,
        code: SEND_REFUSAL.DOMAIN_NOT_VERIFIED,
      });
      expectNoSideEffect();
    });

    it('accepte le sous-domaine dès qu’il est vérifié pour lui-même', async () => {
      givenVerifiedDomains('exemple.gn', 'mail.exemple.gn');

      await expect(
        service.send(USER_ID, dtoWith({ from: 'noreply@mail.exemple.gn' })),
      ).resolves.toMatchObject({ status: 'queued' });
    });
  });

  // ─── (b) casse et nom d'affichage ────────────────────────────────────────
  it('(b) accepte « Service Client <NoReply@EXEMPLE.GN> » et cherche le domaine en minuscules', async () => {
    givenVerifiedDomains('exemple.gn');

    const result = await service.send(
      USER_ID,
      dtoWith({ from: '"Service Client" <NoReply@EXEMPLE.GN>' }),
    );

    expect(result.status).toBe('queued');
    expect(domain.findFirst).toHaveBeenCalledWith({
      where: {
        name: 'exemple.gn',
        userId: USER_ID,
        status: DomainStatus.VERIFIED,
      },
      select: { id: true },
    });
    expect(capturedEmailCreate!.data.fromAddress).toBe(
      'Service Client <noreply@exemple.gn>',
    );
  });

  // ─── (c) reply-to illisible ──────────────────────────────────────────────
  it('(c) refuse en 400 INVALID_REPLY_TO une adresse de réponse illisible', async () => {
    const body = await refusalBodyOf(
      service.send(USER_ID, dtoWith({ replyTo: 'pas-une-adresse' })),
    );

    expect(body).toMatchObject({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      code: SEND_REFUSAL.INVALID_REPLY_TO,
      message: INVALID_REPLY_TO_MESSAGE,
    });
    expectNoSideEffect();
  });

  // ─── (d) reply-to sur un domaine qui n'est pas au client ─────────────────
  describe('(d) l’adresse de réponse subit la règle du From', () => {
    it('refuse en 403 REPLY_TO_NOT_VERIFIED un reply-to sur le domaine d’un tiers, sans ligne ni débit', async () => {
      const body = await refusalBodyOf(
        service.send(
          USER_ID,
          dtoWith({ replyTo: 'pirate@domaine-d-un-tiers.gn' }),
        ),
      );

      expect(body).toMatchObject({
        statusCode: HttpStatus.FORBIDDEN,
        error: 'Forbidden',
        code: SEND_REFUSAL.REPLY_TO_NOT_VERIFIED,
        message: REPLY_TO_NOT_VERIFIED_MESSAGE,
      });
      expectNoSideEffect();
      // Refusé avant tout autre effet de bord : ni suppression, ni solde,
      // ni quota ne sont même consultés.
      expect(suppression.findFirst).not.toHaveBeenCalled();
      expect(creditEntry.aggregate).not.toHaveBeenCalled();
    });

    it('refuse un reply-to sur un sous-domaine non vérifié, comme pour le From', async () => {
      givenVerifiedDomains('exemple.gn');

      const body = await refusalBodyOf(
        service.send(
          USER_ID,
          dtoWith({
            from: 'contact@exemple.gn',
            replyTo: 'sav@mail.exemple.gn',
          }),
        ),
      );

      expect(body.code).toBe(SEND_REFUSAL.REPLY_TO_NOT_VERIFIED);
      expectNoSideEffect();
    });

    /**
     * Le mode bac à sable exempte **l'expéditeur** du domaine vérifié, en
     * échange d'une restriction stricte du destinataire. Étendre l'exemption
     * au reply-to viderait cette contrepartie de son sens.
     */
    it('s’applique aussi en mode bac à sable, où le client n’a par définition aucun domaine vérifié', async () => {
      const TEST_FROM = 'Zendou <essai@mail.kingreys.fr>';
      configValues = { ...configValues, TEST_EMAIL_FROM: TEST_FROM };
      givenVerifiedDomains('mail.kingreys.fr');

      const body = await refusalBodyOf(
        service.send(
          USER_ID,
          dtoWith({
            from: TEST_FROM,
            to: 'aissatou@exemple.gn',
            replyTo: 'sav@boutique-awa.gn',
          }),
        ),
      );

      expect(body.code).toBe(SEND_REFUSAL.REPLY_TO_NOT_VERIFIED);
      expectNoSideEffect();
    });
  });

  // ─── (e) reply-to accepté ────────────────────────────────────────────────
  describe('(e) une adresse de réponse sur un domaine vérifié du compte', () => {
    it('est acceptée et voyage, normalisée, dans le job', async () => {
      const result = await service.send(
        USER_ID,
        dtoWith({ replyTo: '"SAV Awa" <SAV@Boutique-Awa.GN>' }),
      );

      expect(result.status).toBe('queued');
      expect(queue.add).toHaveBeenCalledWith(
        EMAIL_SEND_JOB,
        expect.objectContaining({
          replyTo: 'SAV Awa <sav@boutique-awa.gn>',
        }),
        expect.objectContaining({ jobId: result.id }),
      );
    });

    it('n’ajoute aucun champ au job quand aucune adresse de réponse n’est demandée', async () => {
      const result = await service.send(USER_ID, dtoWith({ text: 'Bonjour' }));

      expect(queue.add).toHaveBeenCalledWith(
        EMAIL_SEND_JOB,
        { emailId: 'email_1', html: '<p>Bonjour</p>', text: 'Bonjour' },
        expect.objectContaining({ jobId: result.id }),
      );
      // `toHaveBeenCalledWith` ignore les propriétés `undefined` : sans cette
      // seconde assertion, un `replyTo: undefined` glissé dans la charge utile
      // passerait inaperçu.
      const [, jobData] = queue.add.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(jobData).not.toHaveProperty('replyTo');
    });
  });

  // ─── destinataire sous la forme « Nom <adresse> » ───────────────────────
  describe('destinataire avec nom d’affichage', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    function lastJob(): Record<string, unknown> {
      const [, jobData] = queue.add.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      return jobData;
    }

    it.each([
      [
        'un nom simple',
        'Client Test <Client@Exemple.GN>',
        'Client Test <client@exemple.gn>',
      ],
      [
        'un nom entre guillemets',
        '"Diallo, Awa" <client@exemple.gn>',
        '"Diallo, Awa" <client@exemple.gn>',
      ],
      [
        'un nom non ASCII',
        'Aïssatou Diallo <client@exemple.gn>',
        'Aïssatou Diallo <client@exemple.gn>',
      ],
    ])(
      'accepte %s : adresse nue en base, nom transmis seulement à SES',
      async (_label, to, expectedDisplay) => {
        const result = await service.send(USER_ID, dtoWith({ to }));
        await flush();

        expect(result.status).toBe('queued');
        expect(capturedEmailCreate!.data.toAddress).toBe('client@exemple.gn');
        expect(lastJob().toDisplay).toBe(expectedDisplay);
      },
    );

    it('accepte toujours l’adresse nue, sans champ toDisplay', async () => {
      await service.send(USER_ID, dtoWith({ to: 'Client@Exemple.GN' }));

      expect(capturedEmailCreate!.data.toAddress).toBe('client@exemple.gn');
      expect(lastJob()).not.toHaveProperty('toDisplay');
    });

    it('vérifie la liste de suppression sur l’adresse nue', async () => {
      await service.send(
        USER_ID,
        dtoWith({ to: 'Client Test <Client@Exemple.GN>' }),
      );

      expect(suppression.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            address: 'client@exemple.gn',
          }) as unknown,
        }),
      );
    });

    it.each(['Nom <pas-une-adresse>', 'Nom <a@b.gn> autre chose', '<>'])(
      'refuse %j en 400 INVALID_TO',
      async (to) => {
        const body = await refusalBodyOf(
          service.send(USER_ID, dtoWith({ to })),
        );

        expect(body).toMatchObject({
          statusCode: 400,
          message: INVALID_TO_MESSAGE,
          code: SEND_REFUSAL.INVALID_TO,
        });
        expectNoSideEffect();
      },
    );
  });

  // ─── en-têtes personnalisés (liste blanche) ──────────────────────────────
  describe('en-têtes personnalisés', () => {
    it('met les en-têtes acceptés dans le job', async () => {
      const headers = {
        'List-Unsubscribe': '<https://exemple.gn/stop>',
        'X-Campagne': 'rentree',
      };

      const result = await service.send(USER_ID, dtoWith({ headers }));

      expect(queue.add).toHaveBeenCalledWith(
        EMAIL_SEND_JOB,
        expect.objectContaining({ headers }),
        expect.objectContaining({ jobId: result.id }),
      );
    });

    it('n’ajoute aucun champ headers au job quand il n’y en a pas', async () => {
      await service.send(USER_ID, dtoWith());
      await service.send(USER_ID, dtoWith({ headers: {} }));

      for (const [, jobData] of queue.add.mock.calls as [
        string,
        Record<string, unknown>,
      ][]) {
        expect(jobData).not.toHaveProperty('headers');
      }
    });

    it.each([
      ['un en-tête réservé', { From: 'pirate@exemple.gn' }],
      ['un préfixe X-SES-', { 'X-SES-CONFIGURATION-SET': 'autre' }],
      ['un CR/LF dans la valeur', { 'X-Test': 'a\r\nBcc: x@exemple.gn' }],
      [
        'plus de 20 en-têtes',
        Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [`X-N${i}`, 'v']),
        ),
      ],
    ])('refuse en 400 %s, sans débit ni job', async (_label, headers) => {
      await expect(service.send(USER_ID, dtoWith({ headers }))).rejects.toThrow(
        BadRequestException,
      );

      expect(email.create).not.toHaveBeenCalled();
      expect(creditEntry.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  // ─── (g) quota journalier : code et Retry-After ──────────────────────────
  describe('(g) le 429 du quota journalier dit quand réessayer', () => {
    it('porte code DAILY_LIMIT_REACHED et un retryAfter strictement positif', async () => {
      email.count.mockResolvedValue(200);

      const body = await refusalBodyOf(service.send(USER_ID, dtoWith()));

      expect(body).toMatchObject({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        code: SEND_REFUSAL.DAILY_LIMIT_REACHED,
        message: DAILY_LIMIT_REACHED_MESSAGE,
      });
      expect(body.retryAfter).toEqual(expect.any(Number));
      expect(body.retryAfter as number).toBeGreaterThan(0);
      // Le quota se remet à zéro à minuit UTC : jamais plus d'une journée.
      expect(body.retryAfter as number).toBeLessThanOrEqual(86_400);
      expectNoSideEffect();
    });

    it('compte jusqu’au prochain minuit UTC - le repère exact de la fenêtre du quota', () => {
      expect(secondsUntilNextUtcDay(new Date('2026-08-11T23:59:30.000Z'))).toBe(
        30,
      );
      expect(secondsUntilNextUtcDay(new Date('2026-08-11T00:00:00.000Z'))).toBe(
        86_400,
      );
      // Jamais 0 : un `Retry-After: 0` invite à réessayer sur un quota qui
      // n'est pas encore libéré.
      expect(
        secondsUntilNextUtcDay(new Date('2026-08-11T23:59:59.999Z')),
      ).toBeGreaterThan(0);
    });
  });

  // ─── code de refus sur chaque 4xx d'envoi ────────────────────────────────
  describe('chaque refus d’envoi porte son code, en plus du statut et du message', () => {
    it.each([
      [
        'INVALID_FROM',
        (): Promise<unknown> =>
          service.send(USER_ID, dtoWith({ from: 'pas-un-email' })),
        HttpStatus.BAD_REQUEST,
        SEND_REFUSAL.INVALID_FROM,
        INVALID_FROM_MESSAGE,
      ],
      [
        'INVALID_TO',
        (): Promise<unknown> =>
          service.send(USER_ID, dtoWith({ to: 'client@localhost' })),
        HttpStatus.BAD_REQUEST,
        SEND_REFUSAL.INVALID_TO,
        INVALID_TO_MESSAGE,
      ],
      [
        'MISSING_BODY',
        (): Promise<unknown> =>
          service.send(USER_ID, dtoWith({ html: undefined, text: '  ' })),
        HttpStatus.BAD_REQUEST,
        SEND_REFUSAL.MISSING_BODY,
        MISSING_BODY_MESSAGE,
      ],
      [
        'BODY_TOO_LARGE',
        (): Promise<unknown> =>
          service.send(USER_ID, dtoWith({ html: 'a'.repeat(500 * 1024 + 1) })),
        HttpStatus.BAD_REQUEST,
        SEND_REFUSAL.BODY_TOO_LARGE,
        BODY_TOO_LARGE_MESSAGE,
      ],
    ])(
      '%s → le corps porte statusCode, error, message et code',
      async (_label, call, status, code, message) => {
        const body = await refusalBodyOf(call());

        expect(body).toMatchObject({ statusCode: status, code, message });
        expect(typeof body.error).toBe('string');
      },
    );

    it('DOMAIN_NOT_VERIFIED - le « 403 dédié » réclamé par l’audit', async () => {
      givenVerifiedDomains();

      const body = await refusalBodyOf(service.send(USER_ID, dtoWith()));

      expect(body).toMatchObject({
        statusCode: HttpStatus.FORBIDDEN,
        error: 'Forbidden',
        code: SEND_REFUSAL.DOMAIN_NOT_VERIFIED,
        message: DOMAIN_NOT_VERIFIED_MESSAGE,
      });
    });

    it('INSUFFICIENT_CREDITS - 402 avec son code', async () => {
      creditEntry.aggregate.mockResolvedValue({ _sum: { delta: 0 } });

      const body = await refusalBodyOf(service.send(USER_ID, dtoWith()));

      expect(body).toMatchObject({
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'Payment Required',
        code: SEND_REFUSAL.INSUFFICIENT_CREDITS,
        message: INSUFFICIENT_CREDITS_MESSAGE,
      });
    });

    it('TEST_SENDER_RECIPIENT_RESTRICTED - 403 du bac à sable avec son code', async () => {
      configValues = {
        ...configValues,
        TEST_EMAIL_FROM: 'Zendou <essai@mail.kingreys.fr>',
      };
      givenVerifiedDomains('mail.kingreys.fr');

      const body = await refusalBodyOf(
        service.send(
          USER_ID,
          dtoWith({
            from: 'Zendou <essai@mail.kingreys.fr>',
            to: 'quelquun-dautre@exemple.gn',
          }),
        ),
      );

      expect(body).toMatchObject({
        statusCode: HttpStatus.FORBIDDEN,
        code: SEND_REFUSAL.TEST_SENDER_RECIPIENT_RESTRICTED,
        message: TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE,
      });
    });

    it('TEST_SENDER_UNAVAILABLE - 503 de configuration avec son code', async () => {
      configValues = {
        ...configValues,
        TEST_EMAIL_FROM: 'Zendou <essai@mail.kingreys.fr>',
      };
      givenVerifiedDomains();

      const body = await refusalBodyOf(
        service.send(
          USER_ID,
          dtoWith({
            from: 'Zendou <essai@mail.kingreys.fr>',
            to: 'aissatou@exemple.gn',
          }),
        ),
      );

      expect(body).toMatchObject({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: SEND_REFUSAL.TEST_SENDER_UNAVAILABLE,
        message: TEST_SENDER_UNAVAILABLE_MESSAGE,
      });
    });

    /**
     * Le corps HTTP gagne un champ ; le reste du contrat ne bouge pas - même
     * classe d'exception, même statut, même phrase, et le motif symbolique que
     * lit le relais SMTP est toujours posé.
     */
    it('sans rien changer à la classe, au statut, au message ni au motif symbolique', async () => {
      givenVerifiedDomains();

      const error = await service
        .send(USER_ID, dtoWith())
        .then(() => null)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).message).toBe(
        DOMAIN_NOT_VERIFIED_MESSAGE,
      );
      expect((error as ForbiddenException).getStatus()).toBe(
        HttpStatus.FORBIDDEN,
      );
      expect(sendRefusalReason(error)).toBe(SEND_REFUSAL.DOMAIN_NOT_VERIFIED);
    });
  });
});

describe('startOfUtcDay', () => {
  it('rewinds to UTC midnight, whatever the local timezone', () => {
    expect(
      startOfUtcDay(new Date('2026-08-11T23:45:12.500Z')).toISOString(),
    ).toBe('2026-08-11T00:00:00.000Z');
    expect(
      startOfUtcDay(new Date('2026-08-11T00:00:00.000Z')).toISOString(),
    ).toBe('2026-08-11T00:00:00.000Z');
  });
});

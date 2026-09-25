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
  const creditEntry = { aggregate: jest.fn(), create: jest.fn() };
  const email = { create: jest.fn(), count: jest.fn() };
  const user = { findUnique: jest.fn() };
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
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(EmailsService);
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
  const creditEntry = { aggregate: jest.fn(), create: jest.fn() };
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

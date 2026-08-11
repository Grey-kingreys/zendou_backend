import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
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
  INSUFFICIENT_CREDITS_MESSAGE,
  INVALID_FROM_MESSAGE,
  INVALID_TO_MESSAGE,
  MISSING_BODY_MESSAGE,
  SEND_JOB_ATTEMPTS,
  SEND_JOB_BACKOFF_DELAY_MS,
} from './emails.constants';
import { EmailsService, startOfUtcDay } from './emails.service';

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

    // Chemin nominal : domaine vérifié, pas de suppression, crédits et
    // quota disponibles. Chaque test ne dérègle que ce qu'il éprouve.
    domain.findFirst.mockResolvedValue({ id: DOMAIN_ID });
    suppression.findFirst.mockResolvedValue(null);
    creditEntry.aggregate.mockResolvedValue({ _sum: { delta: 10 } });
    creditEntry.create.mockResolvedValue({ id: 'credit_1' });
    email.count.mockResolvedValue(0);
    user.findUnique.mockResolvedValue({ dailySendLimit: 200 });
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

    it('counts the emails created since UTC midnight', async () => {
      await service.send(USER_ID, dtoWith());

      expect(email.count).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
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

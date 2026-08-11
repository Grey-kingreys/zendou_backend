import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { EmailStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EmailSendProcessor } from './email-send.processor';
import { SEND_JOB_ATTEMPTS } from './emails.constants';
import type { EmailSendJobData } from './emails.types';
import { SES_SEND_DRIVER, SesSendError } from './ses/ses-send-driver';

const EMAIL_ID = 'email_1';

const storedEmail = {
  id: EMAIL_ID,
  publicId: 'e_0123456789ab',
  userId: 'user_1',
  fromAddress: 'Awa Diallo <contact@boutique-awa.gn>',
  toAddress: 'client@exemple.gn',
  subject: 'Votre commande est prête',
  status: EmailStatus.QUEUED,
};

function jobFor(
  data: Partial<EmailSendJobData> = {},
  overrides: Partial<Job<EmailSendJobData>> = {},
): Job<EmailSendJobData> {
  return {
    data: { emailId: EMAIL_ID, html: '<p>Bonjour</p>', ...data },
    opts: { attempts: SEND_JOB_ATTEMPTS },
    attemptsMade: 1,
    ...overrides,
  } as Job<EmailSendJobData>;
}

interface EmailUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}

describe('EmailSendProcessor', () => {
  let processor: EmailSendProcessor;
  let capturedUpdates: EmailUpdateArgs[];

  const email = { findUnique: jest.fn(), update: jest.fn() };
  const suppression = { findFirst: jest.fn() };
  const prisma = { email, suppression };
  const driver = { send: jest.fn() };

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
    capturedUpdates = [];

    email.findUnique.mockResolvedValue({ ...storedEmail });
    email.update.mockImplementation((args: EmailUpdateArgs) => {
      capturedUpdates.push(args);
      return Promise.resolve({ id: EMAIL_ID });
    });
    suppression.findFirst.mockResolvedValue(null);
    driver.send.mockResolvedValue({ messageId: 'stub-a1b2c3d4' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailSendProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: SES_SEND_DRIVER, useValue: driver },
      ],
    }).compile();

    processor = module.get(EmailSendProcessor);
  });

  function lastUpdate(): EmailUpdateArgs {
    return capturedUpdates[capturedUpdates.length - 1];
  }

  it('sends the email and records SENT with the SES message id', async () => {
    await processor.process(jobFor({ text: 'Bonjour' }));

    expect(driver.send).toHaveBeenCalledWith({
      from: storedEmail.fromAddress,
      to: storedEmail.toAddress,
      subject: storedEmail.subject,
      html: '<p>Bonjour</p>',
      text: 'Bonjour',
    });

    const update = lastUpdate();
    expect(update.where).toEqual({ id: EMAIL_ID });
    expect(update.data).toMatchObject({
      status: EmailStatus.SENT,
      sesMessageId: 'stub-a1b2c3d4',
    });
    expect(update.data.sentAt).toBeInstanceOf(Date);
  });

  it('does nothing when the email row is gone', async () => {
    email.findUnique.mockResolvedValue(null);

    await expect(processor.process(jobFor())).resolves.toBeUndefined();

    expect(driver.send).not.toHaveBeenCalled();
    expect(email.update).not.toHaveBeenCalled();
  });

  it.each([EmailStatus.SENT, EmailStatus.FAILED, EmailStatus.SUPPRESSED])(
    'stays idempotent when the email is already %s',
    async (status) => {
      email.findUnique.mockResolvedValue({ ...storedEmail, status });

      await expect(processor.process(jobFor())).resolves.toBeUndefined();

      expect(driver.send).not.toHaveBeenCalled();
      expect(email.update).not.toHaveBeenCalled();
    },
  );

  it('re-checks the suppression list and stops before calling SES', async () => {
    suppression.findFirst.mockResolvedValue({ id: 'sup_1' });

    await processor.process(jobFor());

    expect(driver.send).not.toHaveBeenCalled();
    expect(lastUpdate().data).toMatchObject({
      status: EmailStatus.SUPPRESSED,
    });
  });

  it('records FAILED without rethrowing on a permanent SES error', async () => {
    driver.send.mockRejectedValue(
      new SesSendError(
        'PERMANENT',
        'MessageRejected: Email address is not verified',
      ),
    );

    await expect(processor.process(jobFor())).resolves.toBeUndefined();

    expect(lastUpdate().data).toMatchObject({
      status: EmailStatus.FAILED,
      errorMessage: 'MessageRejected: Email address is not verified',
    });
  });

  it('rethrows a transient SES error so BullMQ retries', async () => {
    const error = new SesSendError(
      'TRANSIENT',
      'TooManyRequestsException: slow down',
    );
    driver.send.mockRejectedValue(error);

    await expect(processor.process(jobFor())).rejects.toBe(error);

    expect(email.update).not.toHaveBeenCalled();
  });

  it('rethrows an unclassified error rather than losing the email', async () => {
    const error = new Error('socket hang up');
    driver.send.mockRejectedValue(error);

    await expect(processor.process(jobFor())).rejects.toBe(error);

    expect(email.update).not.toHaveBeenCalled();
  });

  describe('onFailed', () => {
    it('leaves the email QUEUED while attempts remain', async () => {
      await processor.onFailed(
        jobFor({}, { attemptsMade: 3 }),
        new Error('timeout'),
      );

      expect(email.update).not.toHaveBeenCalled();
    });

    it('records FAILED once the attempts are exhausted', async () => {
      await processor.onFailed(
        jobFor({}, { attemptsMade: SEND_JOB_ATTEMPTS }),
        new Error('timeout'),
      );

      expect(lastUpdate()).toMatchObject({
        where: { id: EMAIL_ID },
        data: { status: EmailStatus.FAILED, errorMessage: 'timeout' },
      });
    });

    it('ignores an event without a job', async () => {
      await expect(
        processor.onFailed(undefined, new Error('timeout')),
      ).resolves.toBeUndefined();

      expect(email.update).not.toHaveBeenCalled();
    });

    it('swallows a database failure while marking the email', async () => {
      email.update.mockRejectedValue(new Error('connexion perdue'));

      await expect(
        processor.onFailed(
          jobFor({}, { attemptsMade: SEND_JOB_ATTEMPTS }),
          new Error('timeout'),
        ),
      ).resolves.toBeUndefined();
    });
  });
});

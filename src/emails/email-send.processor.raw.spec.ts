import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import {
  SendEmailCommand,
  SESv2Client,
  type SendEmailCommandInput,
} from '@aws-sdk/client-sesv2';
import { EmailStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ReputationService } from '../reputation';
import { EmailSendProcessor } from './email-send.processor';
import { SEND_JOB_ATTEMPTS } from './emails.constants';
import type { EmailSendJobData } from './emails.types';
import { SES_SEND_DRIVER } from './ses/ses-send-driver';
import { SesSendSdkDriver } from './ses/ses-send-sdk.driver';

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

function jobFor(data: EmailSendJobData): Job<EmailSendJobData> {
  return {
    data,
    opts: { attempts: SEND_JOB_ATTEMPTS },
    attemptsMade: 1,
  } as Job<EmailSendJobData>;
}

/**
 * Chaîne complète job → worker → driver SESv2 réel, l'appel HTTP en moins :
 * ce qui est asserté ici est l'entrée effectivement remise au
 * `SendEmailCommand`, pas un intermédiaire.
 */
describe('EmailSendProcessor — contenu Raw et compatibilité des jobs en vol', () => {
  let processor: EmailSendProcessor;
  let commands: SendEmailCommand[];
  let updates: { where: { id: string }; data: Record<string, unknown> }[];

  const email = { findUnique: jest.fn(), update: jest.fn() };
  const suppression = { findFirst: jest.fn() };
  const prisma = { email, suppression };
  const reputation = { recomputeDailyLimit: jest.fn() };

  function lastInput(): SendEmailCommandInput {
    return commands[commands.length - 1].input;
  }

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    commands = [];
    updates = [];

    email.findUnique.mockResolvedValue({ ...storedEmail });
    email.update.mockImplementation(
      (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return Promise.resolve({ id: EMAIL_ID });
      },
    );
    suppression.findFirst.mockResolvedValue(null);
    reputation.recomputeDailyLimit.mockResolvedValue(200);

    jest.spyOn(SESv2Client.prototype, 'send').mockImplementation(((
      command: SendEmailCommand,
    ) => {
      commands.push(command);
      return Promise.resolve({ MessageId: 'ses-msg-1' });
    }) as never);

    const driver = new SesSendSdkDriver({
      region: 'eu-west-3',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailSendProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: SES_SEND_DRIVER, useValue: driver },
        { provide: ReputationService, useValue: reputation },
      ],
    }).compile();

    processor = module.get(EmailSendProcessor);
  });

  describe('jobs en vol au moment du déploiement', () => {
    // 🔴 Le point critique de la tâche : les jobs déjà en file n'ont pas de
    // champ `kind`. Si le worker les refusait ou les traitait en Raw, le
    // déploiement perdrait tous les emails acceptés et déjà facturés.
    it('treats a job without `kind` as Simple content', async () => {
      const job = {
        emailId: EMAIL_ID,
        html: '<p>Bonjour</p>',
        text: 'Bonjour',
      };

      // Preuve que la donnée testée est bien celle d'avant la migration.
      expect(job).not.toHaveProperty('kind');

      await processor.process(jobFor(job));

      expect(lastInput().Content).toEqual({
        Simple: {
          Subject: { Data: storedEmail.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: '<p>Bonjour</p>', Charset: 'UTF-8' },
            Text: { Data: 'Bonjour', Charset: 'UTF-8' },
          },
        },
      });
      expect(lastInput().Content?.Raw).toBeUndefined();
    });

    it('marks a job without `kind` as SENT rather than losing it', async () => {
      await processor.process(jobFor({ emailId: EMAIL_ID, html: '<p>Ok</p>' }));

      expect(updates[updates.length - 1].data).toMatchObject({
        status: EmailStatus.SENT,
        sesMessageId: 'ses-msg-1',
      });
    });

    it('builds the same request with or without an explicit `kind`', async () => {
      await processor.process(jobFor({ emailId: EMAIL_ID, html: '<p>Ok</p>' }));
      await processor.process(
        jobFor({ emailId: EMAIL_ID, kind: 'simple', html: '<p>Ok</p>' }),
      );

      expect(commands).toHaveLength(2);
      expect(commands[1].input).toEqual(commands[0].input);
    });
  });

  describe('jobs Raw', () => {
    const raw = [
      'From: Awa Diallo <contact@boutique-awa.gn>',
      'To: client@exemple.gn',
      'Bcc: espion@ailleurs.gn',
      'Subject: Facture',
      '',
      'Merci pour votre commande.',
    ].join('\r\n');

    it('forwards the MIME bytes to SES as Content.Raw.Data', async () => {
      await processor.process(jobFor({ emailId: EMAIL_ID, kind: 'raw', raw }));

      expect(lastInput().Content?.Raw?.Data).toEqual(Buffer.from(raw, 'utf8'));
      expect(lastInput().Content?.Simple).toBeUndefined();
    });

    // L'adressage remis à SES vient de la ligne `Email`, pas des en-têtes du
    // message : un `Bcc:` oublié dans le brut ne peut pas devenir un envoi.
    it('addresses the email from the database row, not from its headers', async () => {
      await processor.process(jobFor({ emailId: EMAIL_ID, kind: 'raw', raw }));

      expect(lastInput().Destination).toEqual({
        ToAddresses: [storedEmail.toAddress],
      });
      expect(lastInput().FromEmailAddress).toBe(storedEmail.fromAddress);
    });

    it('records SENT with the SES message id', async () => {
      await processor.process(jobFor({ emailId: EMAIL_ID, kind: 'raw', raw }));

      expect(updates[updates.length - 1].data).toMatchObject({
        status: EmailStatus.SENT,
        sesMessageId: 'ses-msg-1',
      });
    });

    it('re-checks the suppression list before sending anything raw', async () => {
      suppression.findFirst.mockResolvedValue({ id: 'sup_1' });

      await processor.process(jobFor({ emailId: EMAIL_ID, kind: 'raw', raw }));

      expect(commands).toHaveLength(0);
      expect(updates[updates.length - 1].data).toMatchObject({
        status: EmailStatus.SUPPRESSED,
      });
    });
  });
});

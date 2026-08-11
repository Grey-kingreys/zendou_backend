import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { EmailStatus, SuppressionReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReputationService } from '../reputation';
import {
  complaintFixture,
  deliveryFixture,
  permanentBounceFixture,
  permanentBounceMultiFixture,
  subscriptionConfirmationFixture,
  transientBounceFixture,
  unsubscribeConfirmationFixture,
  FIXTURE_COMPLAINT_SES_MESSAGE_ID,
  FIXTURE_SES_MESSAGE_ID,
} from './fixtures';
import { SnsHttpClient } from './sns-http.client';
import {
  buildBounceErrorMessage,
  SnsWebhookService,
} from './sns-webhook.service';
import {
  HARD_BOUNCE_ERROR_PREFIX,
  type SesEventPayload,
  type SnsMessage,
} from './sns-webhook.types';

const EMAIL_ROW = { id: 'email_1', userId: 'user_1' };

/** Événement SES transporté par une fixture SNS. */
function sesPayload(message: SnsMessage): SesEventPayload {
  return JSON.parse(message.Message) as SesEventPayload;
}

describe('SnsWebhookService', () => {
  let service: SnsWebhookService;

  const email = { findUnique: jest.fn(), update: jest.fn() };
  const suppression = { upsert: jest.fn() };
  const httpClient = { get: jest.fn() };
  const reputation = { evaluate: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    email.findUnique.mockResolvedValue(EMAIL_ROW);
    email.update.mockResolvedValue(EMAIL_ROW);
    suppression.upsert.mockResolvedValue({ id: 'sup_1' });
    httpClient.get.mockResolvedValue('<ConfirmSubscriptionResponse/>');
    reputation.evaluate.mockResolvedValue({ verdict: 'OK' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SnsWebhookService,
        { provide: PrismaService, useValue: { email, suppression } },
        { provide: SnsHttpClient, useValue: httpClient },
        { provide: ReputationService, useValue: reputation },
      ],
    }).compile();

    service = module.get(SnsWebhookService);
  });

  describe('SubscriptionConfirmation', () => {
    it('confirms the subscription by calling SubscribeURL', async () => {
      const message = subscriptionConfirmationFixture();

      await service.handle(message);

      expect(httpClient.get).toHaveBeenCalledWith(message.SubscribeURL);
      expect(email.update).not.toHaveBeenCalled();
    });

    it('never calls a SubscribeURL hosted outside AWS SNS', async () => {
      const message = {
        ...subscriptionConfirmationFixture(),
        SubscribeURL: 'https://evil.gn/?Action=ConfirmSubscription',
      };

      await service.handle(message);

      expect(httpClient.get).not.toHaveBeenCalled();
    });
  });

  describe('Delivery', () => {
    it('marks the email delivered with the SES event timestamp', async () => {
      await service.handle(deliveryFixture());

      expect(email.findUnique).toHaveBeenCalledWith({
        where: { sesMessageId: FIXTURE_SES_MESSAGE_ID },
        select: { id: true, userId: true },
      });
      expect(email.update).toHaveBeenCalledWith({
        where: { id: 'email_1' },
        data: {
          status: EmailStatus.DELIVERED,
          deliveredAt: new Date('2026-08-11T10:00:02.789Z'),
          lastEventAt: new Date('2026-08-11T10:00:02.789Z'),
        },
      });
      expect(suppression.upsert).not.toHaveBeenCalled();
    });
  });

  describe('Bounce', () => {
    it('suppresses the recipient (lower-cased) on a permanent bounce', async () => {
      await service.handle(permanentBounceFixture());

      expect(suppression.upsert).toHaveBeenCalledTimes(1);
      expect(suppression.upsert).toHaveBeenCalledWith({
        where: {
          address_userId: {
            address: 'mamadou.barry@example.com',
            userId: 'user_1',
          },
        },
        create: {
          address: 'mamadou.barry@example.com',
          reason: SuppressionReason.HARD_BOUNCE,
          userId: 'user_1',
        },
        update: {},
      });
    });

    it('marks the email bounced with a readable diagnostic', async () => {
      await service.handle(permanentBounceFixture());

      expect(email.update).toHaveBeenCalledWith({
        where: { id: 'email_1' },
        data: {
          status: EmailStatus.BOUNCED,
          errorMessage:
            'Bounce Permanent/General — smtp; 550 5.1.1 <Mamadou.Barry@Example.COM>: Recipient address rejected: User unknown in virtual mailbox table',
          lastEventAt: new Date('2026-08-11T10:01:12.345Z'),
        },
      });
    });

    it('suppresses every recipient of a multi-recipient bounce', async () => {
      await service.handle(permanentBounceMultiFixture());

      expect(suppression.upsert).toHaveBeenCalledTimes(2);
      expect(
        suppression.upsert.mock.calls.map(
          (call: [{ create: { address: string } }]) => call[0].create.address,
        ),
      ).toEqual(['mamadou.barry@example.com', 'fatoumata.camara@example.com']);
    });

    it('does not suppress anything on a transient bounce', async () => {
      await service.handle(transientBounceFixture());

      expect(suppression.upsert).not.toHaveBeenCalled();
      expect(email.update).toHaveBeenCalledWith({
        where: { id: 'email_1' },
        data: {
          status: EmailStatus.BOUNCED,
          errorMessage:
            'Bounce Transient/MailboxFull — smtp; 452 4.2.2 The email account that you tried to reach is over quota',
          lastEventAt: new Date('2026-08-11T10:03:05.250Z'),
        },
      });
    });

    /**
     * Le message écrit est la seule trace durable de la nature du rebond :
     * `ReputationService` s'en sert pour ne sanctionner que les rebonds durs.
     * Le préfixe est donc un contrat, pas un détail de formatage.
     */
    it('guarantees the hard-bounce prefix the reputation service reads', () => {
      expect(
        buildBounceErrorMessage(sesPayload(permanentBounceFixture())),
      ).toMatch(new RegExp(`^${HARD_BOUNCE_ERROR_PREFIX}/`));
      expect(
        buildBounceErrorMessage(
          sesPayload(transientBounceFixture()),
        ).startsWith(HARD_BOUNCE_ERROR_PREFIX),
      ).toBe(false);
    });

    it('never mistakes an undetermined bounce for a hard one', () => {
      const payload = sesPayload(transientBounceFixture());
      delete payload.bounce?.bounceType;

      expect(
        buildBounceErrorMessage(payload).startsWith(HARD_BOUNCE_ERROR_PREFIX),
      ).toBe(false);
    });
  });

  describe('Complaint', () => {
    it('suppresses the complainant and marks the email complained', async () => {
      await service.handle(complaintFixture());

      expect(email.findUnique).toHaveBeenCalledWith({
        where: { sesMessageId: FIXTURE_COMPLAINT_SES_MESSAGE_ID },
        select: { id: true, userId: true },
      });
      expect(suppression.upsert).toHaveBeenCalledWith({
        where: {
          address_userId: {
            address: 'ibrahima.sow@example.com',
            userId: 'user_1',
          },
        },
        create: {
          address: 'ibrahima.sow@example.com',
          reason: SuppressionReason.COMPLAINT,
          userId: 'user_1',
        },
        update: {},
      });
      expect(email.update).toHaveBeenCalledWith({
        where: { id: 'email_1' },
        data: {
          status: EmailStatus.COMPLAINED,
          lastEventAt: new Date('2026-08-11T11:15:44.678Z'),
        },
      });
    });
  });

  describe('reputation hook', () => {
    it('re-evaluates the sender after a permanent bounce', async () => {
      await service.handle(permanentBounceFixture());

      expect(reputation.evaluate).toHaveBeenCalledWith('user_1');
    });

    it('re-evaluates the sender after a transient bounce', async () => {
      await service.handle(transientBounceFixture());

      expect(reputation.evaluate).toHaveBeenCalledWith('user_1');
    });

    it('re-evaluates the sender after a complaint', async () => {
      await service.handle(complaintFixture());

      expect(reputation.evaluate).toHaveBeenCalledWith('user_1');
    });

    it('never re-evaluates on a delivery', async () => {
      await service.handle(deliveryFixture());

      expect(reputation.evaluate).not.toHaveBeenCalled();
    });

    // SNS rejoue puis désabonne un endpoint qui n'acquitte pas : une
    // évaluation en échec ne doit jamais faire échouer le webhook.
    it('swallows an evaluation failure so SNS still gets its 200', async () => {
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      reputation.evaluate.mockRejectedValue(new Error('base indisponible'));

      await expect(
        service.handle(permanentBounceFixture()),
      ).resolves.toBeUndefined();

      expect(email.update).toHaveBeenCalled();
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    });
  });

  describe('messages that must not write anything', () => {
    it('ignores an event whose SES messageId is unknown', async () => {
      email.findUnique.mockResolvedValue(null);

      await service.handle(permanentBounceFixture());

      expect(email.update).not.toHaveBeenCalled();
      expect(suppression.upsert).not.toHaveBeenCalled();
    });

    it('ignores an UnsubscribeConfirmation', async () => {
      await service.handle(unsubscribeConfirmationFixture());

      expect(httpClient.get).not.toHaveBeenCalled();
      expect(email.update).not.toHaveBeenCalled();
    });

    it('ignores an unknown SNS message type', async () => {
      await service.handle({ ...deliveryFixture(), Type: 'SomethingElse' });

      expect(email.findUnique).not.toHaveBeenCalled();
      expect(email.update).not.toHaveBeenCalled();
    });

    it('ignores an unknown SES event type', async () => {
      const message = deliveryFixture();
      const payload = JSON.parse(message.Message) as { eventType: string };
      payload.eventType = 'Open';

      await service.handle({ ...message, Message: JSON.stringify(payload) });

      expect(email.update).not.toHaveBeenCalled();
      expect(suppression.upsert).not.toHaveBeenCalled();
    });

    it('survives a Message field that is not valid JSON', async () => {
      await service.handle({ ...deliveryFixture(), Message: 'not json {' });

      expect(email.findUnique).not.toHaveBeenCalled();
      expect(email.update).not.toHaveBeenCalled();
    });
  });

  it('also understands the legacy notificationType field', async () => {
    const message = deliveryFixture();
    const payload = JSON.parse(message.Message) as {
      eventType?: string;
      notificationType?: string;
    };
    delete payload.eventType;
    payload.notificationType = 'Delivery';

    await service.handle({ ...message, Message: JSON.stringify(payload) });

    expect(email.update).toHaveBeenCalledWith({
      where: { id: 'email_1' },
      data: {
        status: EmailStatus.DELIVERED,
        deliveredAt: new Date('2026-08-11T10:00:02.789Z'),
        lastEventAt: new Date('2026-08-11T10:00:02.789Z'),
      },
    });
  });
});

import { Injectable, Logger } from '@nestjs/common';
import { EmailStatus, SuppressionReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SnsHttpClient } from './sns-http.client';
import { isTrustedSnsUrl } from './sns-signature.validator';
import {
  PERMANENT_BOUNCE_TYPE,
  type SesEventPayload,
  type SnsMessage,
} from './sns-webhook.types';

/** Colonne `errorMessage` : on garde un diagnostic lisible, pas un roman. */
const MAX_ERROR_MESSAGE_LENGTH = 500;

interface TargetEmail {
  id: string;
  userId: string;
}

/**
 * Traitement des événements SES reçus via SNS : c'est le mécanisme de
 * protection de la réputation d'envoi (bounces durs et plaintes alimentent
 * la liste de suppression).
 */
@Injectable()
export class SnsWebhookService {
  private readonly logger = new Logger(SnsWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpClient: SnsHttpClient,
  ) {}

  async handle(message: SnsMessage): Promise<void> {
    switch (message.Type) {
      case 'SubscriptionConfirmation':
        await this.confirmSubscription(message);
        return;
      case 'Notification':
        await this.handleNotification(message);
        return;
      case 'UnsubscribeConfirmation':
        this.logger.log(
          `Désabonnement SNS confirmé (TopicArn=${message.TopicArn ?? 'inconnu'})`,
        );
        return;
      default:
        this.logger.log(`Type de message SNS ignoré: ${message.Type}`);
    }
  }

  /** Confirme l'abonnement en appelant `SubscribeURL` (hôte AWS vérifié). */
  private async confirmSubscription(message: SnsMessage): Promise<void> {
    if (!isTrustedSnsUrl(message.SubscribeURL)) {
      this.logger.warn(
        `SubscribeURL non fiable, abonnement non confirmé: ${message.SubscribeURL ?? '(absente)'}`,
      );
      return;
    }

    await this.httpClient.get(message.SubscribeURL as string);
    this.logger.log(
      `Abonnement SNS confirmé (TopicArn=${message.TopicArn ?? 'inconnu'})`,
    );
  }

  private async handleNotification(message: SnsMessage): Promise<void> {
    const payload = this.parseSesPayload(message.Message);
    if (!payload) {
      return;
    }

    const eventType = payload.eventType ?? payload.notificationType;
    const sesMessageId = payload.mail?.messageId;

    if (!sesMessageId) {
      this.logger.warn(
        `Événement SES ${eventType ?? 'inconnu'} sans mail.messageId — ignoré`,
      );
      return;
    }

    const email = await this.prisma.email.findUnique({
      where: { sesMessageId },
      select: { id: true, userId: true },
    });

    if (!email) {
      // Email envoyé hors Zendou (ou purgé) : on acquitte sans rien écrire.
      this.logger.debug(
        `Événement SES ${eventType ?? 'inconnu'} pour un messageId inconnu: ${sesMessageId}`,
      );
      return;
    }

    switch (eventType) {
      case 'Delivery':
        await this.applyDelivery(email, payload);
        return;
      case 'Bounce':
        await this.applyBounce(email, payload);
        return;
      case 'Complaint':
        await this.applyComplaint(email, payload);
        return;
      default:
        this.logger.log(
          `Événement SES non traité: ${eventType ?? 'inconnu'} (messageId=${sesMessageId})`,
        );
    }
  }

  private async applyDelivery(
    email: TargetEmail,
    payload: SesEventPayload,
  ): Promise<void> {
    const occurredAt = parseEventDate(payload.delivery?.timestamp);

    await this.prisma.email.update({
      where: { id: email.id },
      data: {
        status: EmailStatus.DELIVERED,
        deliveredAt: occurredAt,
        lastEventAt: occurredAt,
      },
    });
  }

  private async applyBounce(
    email: TargetEmail,
    payload: SesEventPayload,
  ): Promise<void> {
    const bounce = payload.bounce ?? {};
    const occurredAt = parseEventDate(bounce.timestamp);
    const isPermanent = bounce.bounceType === PERMANENT_BOUNCE_TYPE;

    if (isPermanent) {
      // Bounce dur : l'adresse ne doit plus jamais être adressée.
      for (const recipient of bounce.bouncedRecipients ?? []) {
        await this.suppress(
          recipient.emailAddress,
          email.userId,
          SuppressionReason.HARD_BOUNCE,
        );
      }
    }

    await this.prisma.email.update({
      where: { id: email.id },
      data: {
        status: EmailStatus.BOUNCED,
        errorMessage: buildBounceErrorMessage(payload),
        lastEventAt: occurredAt,
      },
    });
  }

  private async applyComplaint(
    email: TargetEmail,
    payload: SesEventPayload,
  ): Promise<void> {
    const complaint = payload.complaint ?? {};
    const occurredAt = parseEventDate(complaint.timestamp);

    for (const recipient of complaint.complainedRecipients ?? []) {
      await this.suppress(
        recipient.emailAddress,
        email.userId,
        SuppressionReason.COMPLAINT,
      );
    }

    await this.prisma.email.update({
      where: { id: email.id },
      data: {
        status: EmailStatus.COMPLAINED,
        lastEventAt: occurredAt,
      },
    });
  }

  /** Idempotent : rejoue le même événement sans créer de doublon. */
  private async suppress(
    rawAddress: string | undefined,
    userId: string,
    reason: SuppressionReason,
  ): Promise<void> {
    const address = rawAddress?.trim().toLowerCase();
    if (!address) {
      return;
    }

    await this.prisma.suppression.upsert({
      where: { address_userId: { address, userId } },
      create: { address, reason, userId },
      update: {},
    });

    this.logger.log(
      `Adresse mise en suppression (${reason}) pour l'utilisateur ${userId}`,
    );
  }

  private parseSesPayload(raw: string): SesEventPayload | undefined {
    try {
      return JSON.parse(raw) as SesEventPayload;
    } catch {
      this.logger.warn('Champ Message SNS illisible (JSON invalide) — ignoré');
      return undefined;
    }
  }
}

function buildBounceErrorMessage(payload: SesEventPayload): string {
  const bounce = payload.bounce ?? {};
  const diagnostic = bounce.bouncedRecipients?.find(
    (recipient) => recipient.diagnosticCode,
  )?.diagnosticCode;

  const parts = [
    `Bounce ${bounce.bounceType ?? 'Unknown'}/${bounce.bounceSubType ?? 'Unknown'}`,
    diagnostic,
  ].filter((part): part is string => Boolean(part));

  return parts.join(' — ').slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/** Horodatage de l'événement SES ; à défaut, l'heure de réception. */
function parseEventDate(raw: string | undefined): Date {
  if (raw) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return new Date();
}

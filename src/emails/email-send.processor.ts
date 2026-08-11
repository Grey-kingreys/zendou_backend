import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { EmailStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import { ERROR_MESSAGE_MAX_LENGTH } from './emails.constants';
import type { EmailSendJobData } from './emails.types';
import {
  SES_SEND_DRIVER,
  isPermanentSendError,
  type SesSendDriver,
} from './ses/ses-send-driver';
import { describeError } from './ses/ses-send-sdk.driver';
import { isAddressSuppressed } from './suppressions';

/** Colonnes nécessaires au worker pour composer et tracer l'envoi. */
const EMAIL_SELECT = {
  id: true,
  publicId: true,
  userId: true,
  fromAddress: true,
  toAddress: true,
  subject: true,
  status: true,
} as const;

/**
 * Worker d'envoi. Rejouable sans dommage : un job repris sur un email qui
 * n'est plus `QUEUED` ne fait rien.
 */
@Processor(EMAIL_SEND_QUEUE)
export class EmailSendProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailSendProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SES_SEND_DRIVER)
    private readonly driver: SesSendDriver,
  ) {
    super();
  }

  async process(job: Job<EmailSendJobData>): Promise<void> {
    const { emailId, html, text } = job.data;

    const email = await this.prisma.email.findUnique({
      where: { id: emailId },
      select: EMAIL_SELECT,
    });

    if (!email) {
      this.logger.warn(`Email ${emailId} introuvable — job ignoré`);
      return;
    }

    // Idempotence : le job a déjà abouti (ou a été tranché autrement).
    if (email.status !== EmailStatus.QUEUED) {
      this.logger.log(
        `Email ${email.publicId} déjà en statut ${email.status} — job ignoré`,
      );
      return;
    }

    // L'adresse a pu être ajoutée à la liste de suppression entre
    // l'acceptation et l'envoi. Le crédit reste débité : choix assumé v1.
    if (await isAddressSuppressed(this.prisma, email.userId, email.toAddress)) {
      await this.prisma.email.update({
        where: { id: email.id },
        data: { status: EmailStatus.SUPPRESSED, lastEventAt: new Date() },
      });
      this.logger.log(
        `Email ${email.publicId} bloqué : ${email.toAddress} est sur la liste de suppression`,
      );
      return;
    }

    try {
      const { messageId } = await this.driver.send({
        from: email.fromAddress,
        to: email.toAddress,
        subject: email.subject,
        html,
        text,
      });

      const now = new Date();
      await this.prisma.email.update({
        where: { id: email.id },
        data: {
          status: EmailStatus.SENT,
          sentAt: now,
          lastEventAt: now,
          sesMessageId: messageId,
        },
      });
    } catch (error) {
      if (isPermanentSendError(error)) {
        // Rien à retenter : on clôt l'email immédiatement, sans relancer.
        await this.markFailed(email.id, error);
        this.logger.warn(
          `Email ${email.publicId} rejeté définitivement : ${describeError(error)}`,
        );
        return;
      }

      // Erreur temporaire : on laisse BullMQ réessayer.
      throw error;
    }
  }

  /**
   * Dernier recours : le job a épuisé ses tentatives. Les échecs
   * intermédiaires passent aussi par cet événement, d'où le contrôle du
   * nombre de tentatives restantes.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<EmailSendJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) {
      return;
    }

    const maxAttempts = job.opts.attempts ?? 1;

    if (job.attemptsMade < maxAttempts) {
      this.logger.warn(
        `Tentative ${job.attemptsMade}/${maxAttempts} en échec pour l'email ${job.data.emailId} : ${describeError(error)}`,
      );
      return;
    }

    try {
      await this.markFailed(job.data.emailId, error);
      this.logger.error(
        `Email ${job.data.emailId} abandonné après ${maxAttempts} tentatives : ${describeError(error)}`,
      );
    } catch (updateError) {
      this.logger.error(
        `Impossible de marquer l'email ${job.data.emailId} en échec`,
        updateError instanceof Error ? updateError.stack : String(updateError),
      );
    }
  }

  private async markFailed(emailId: string, error: unknown): Promise<void> {
    await this.prisma.email.update({
      where: { id: emailId },
      data: {
        status: EmailStatus.FAILED,
        errorMessage: describeError(error).slice(0, ERROR_MESSAGE_MAX_LENGTH),
        lastEventAt: new Date(),
      },
    });
  }
}

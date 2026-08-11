import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { DomainStatus, EmailStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import {
  formatEmailAddress,
  normalizeEmailAddress,
  parseEmailAddress,
} from './email-address';
import {
  BODY_TOO_LARGE_MESSAGE,
  CREDITS_PER_EMAIL,
  CREDIT_REASON_SEND,
  DAILY_LIMIT_REACHED_MESSAGE,
  DOMAIN_NOT_VERIFIED_MESSAGE,
  EMAIL_PUBLIC_ID_BYTES,
  EMAIL_PUBLIC_ID_PREFIX,
  EMAIL_SEND_JOB,
  INSUFFICIENT_CREDITS_MESSAGE,
  INVALID_FROM_MESSAGE,
  INVALID_TO_MESSAGE,
  MAX_BODY_BYTES,
  MISSING_BODY_MESSAGE,
  SEND_JOB_ATTEMPTS,
  SEND_JOB_BACKOFF_DELAY_MS,
} from './emails.constants';
import type { EmailSendJobData, SendEmailResponse } from './emails.types';
import type { SendEmailDto } from './dto/send-email.dto';
import { isAddressSuppressed } from './suppressions';

@Injectable()
export class EmailsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EMAIL_SEND_QUEUE)
    private readonly queue: Queue<EmailSendJobData>,
  ) {}

  /**
   * Accepte un email : valide la requête, contrôle le domaine, la liste de
   * suppression, le solde et le quota, débite un crédit puis met le job en
   * file. L'envoi lui-même est fait par `EmailSendProcessor`.
   */
  async send(userId: string, dto: SendEmailDto): Promise<SendEmailResponse> {
    const from = parseEmailAddress(dto.from);

    if (!from) {
      throw new BadRequestException(INVALID_FROM_MESSAGE);
    }

    // Un seul destinataire en v1, et sous forme d'adresse nue.
    const toAddress = normalizeEmailAddress(dto.to);

    if (!toAddress) {
      throw new BadRequestException(INVALID_TO_MESSAGE);
    }

    const html = blankToUndefined(dto.html);
    const text = blankToUndefined(dto.text);

    if (!html && !text) {
      throw new BadRequestException(MISSING_BODY_MESSAGE);
    }

    if (exceedsMaxBody(html) || exceedsMaxBody(text)) {
      throw new BadRequestException(BODY_TOO_LARGE_MESSAGE);
    }

    const domainId = await this.requireVerifiedDomain(userId, from.domain);
    const fromAddress = formatEmailAddress(from);
    const common = {
      userId,
      domainId,
      fromAddress,
      toAddress,
      subject: dto.subject,
    };

    // Adresse bloquée : on trace l'email pour que le client le voie dans
    // son journal, mais sans le facturer ni le mettre en file.
    if (await isAddressSuppressed(this.prisma, userId, toAddress)) {
      const suppressed = await this.prisma.email.create({
        data: {
          ...common,
          publicId: generateEmailPublicId(),
          status: EmailStatus.SUPPRESSED,
          lastEventAt: new Date(),
        },
        select: { publicId: true },
      });

      return { id: suppressed.publicId, status: 'suppressed' };
    }

    await this.assertSufficientCredits(userId);
    await this.assertDailyLimitNotReached(userId);

    const publicId = generateEmailPublicId();

    // Création de l'email et débit du crédit indissociables : jamais de
    // ligne facturée sans email, ni d'email envoyé sans être facturé.
    const email = await this.prisma.$transaction(async (tx) => {
      const created = await tx.email.create({
        data: { ...common, publicId, status: EmailStatus.QUEUED },
        select: { id: true, publicId: true },
      });

      await tx.creditEntry.create({
        data: {
          userId,
          delta: -CREDITS_PER_EMAIL,
          reason: CREDIT_REASON_SEND,
          reference: publicId,
        },
      });

      return created;
    });

    // Après commit seulement : un job déposé sur une transaction annulée
    // pointerait sur un email inexistant.
    await this.queue.add(
      EMAIL_SEND_JOB,
      { emailId: email.id, html, text },
      {
        // L'identifiant public sert de clé d'idempotence côté file.
        jobId: email.publicId,
        attempts: SEND_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: SEND_JOB_BACKOFF_DELAY_MS },
        removeOnComplete: true,
      },
    );

    return { id: email.publicId, status: 'queued' };
  }

  /**
   * Vérifie que le domaine de l'expéditeur appartient au client et qu'il
   * est vérifié. Un domaine appartenant à un tiers donne la même réponse
   * qu'un domaine inconnu : pas d'oracle sur les domaines des autres.
   */
  private async requireVerifiedDomain(
    userId: string,
    name: string,
  ): Promise<string> {
    const domain = await this.prisma.domain.findFirst({
      where: { name, userId, status: DomainStatus.VERIFIED },
      select: { id: true },
    });

    if (!domain) {
      throw new ForbiddenException(DOMAIN_NOT_VERIFIED_MESSAGE);
    }

    return domain.id;
  }

  /** Le solde est la somme des mouvements de crédits du client. */
  private async assertSufficientCredits(userId: string): Promise<void> {
    const { _sum } = await this.prisma.creditEntry.aggregate({
      where: { userId },
      _sum: { delta: true },
    });

    if ((_sum.delta ?? 0) < CREDITS_PER_EMAIL) {
      throw new HttpException(
        INSUFFICIENT_CREDITS_MESSAGE,
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }

  /** Quota journalier, compté sur les emails créés depuis minuit UTC. */
  private async assertDailyLimitNotReached(userId: string): Promise<void> {
    const [user, today] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { dailySendLimit: true },
      }),
      this.prisma.email.count({
        where: { userId, queuedAt: { gte: startOfUtcDay(new Date()) } },
      }),
    ]);

    if (user && today >= user.dailySendLimit) {
      throw new HttpException(
        DAILY_LIMIT_REACHED_MESSAGE,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

/** Identifiant public d'un email : `e_` suivi de 12 caractères hex. */
export function generateEmailPublicId(): string {
  return `${EMAIL_PUBLIC_ID_PREFIX}${randomBytes(EMAIL_PUBLIC_ID_BYTES).toString('hex')}`;
}

/** Minuit UTC du jour de `reference`. */
export function startOfUtcDay(reference: Date): Date {
  return new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate(),
    ),
  );
}

/** Traite une chaîne vide ou blanche comme un contenu absent. */
function blankToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

/** Taille du contenu mesurée en octets UTF-8, pas en caractères. */
function exceedsMaxBody(value: string | undefined): boolean {
  return (
    value !== undefined && Buffer.byteLength(value, 'utf8') > MAX_BODY_BYTES
  );
}

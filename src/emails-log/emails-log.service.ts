import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmailStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  EmailDetail,
  EmailListItem,
  PaginatedEmails,
  RawEmailsListQuery,
} from './emails-log.types';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const EMAIL_LIST_SELECT = {
  publicId: true,
  fromAddress: true,
  toAddress: true,
  subject: true,
  status: true,
  queuedAt: true,
  sentAt: true,
  deliveredAt: true,
  lastEventAt: true,
} satisfies Record<keyof EmailListItem, true>;

const EMAIL_DETAIL_SELECT = {
  ...EMAIL_LIST_SELECT,
  errorMessage: true,
  sesMessageId: true,
} satisfies Record<keyof EmailDetail, true>;

/**
 * Journal des envois — lecture seule. La création des `Email` arrive avec
 * le pipeline d'envoi (tâche séparée).
 */
@Injectable()
export class EmailsLogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    query: RawEmailsListQuery,
  ): Promise<PaginatedEmails> {
    const status = this.parseStatus(query.status);
    const page = this.parsePositiveInt(query.page, 'page', DEFAULT_PAGE);
    const limit = this.parsePositiveInt(
      query.limit,
      'limit',
      DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const { from, to } = this.parseDateRange(query.from, query.to);

    const where: Prisma.EmailWhereInput = { userId };

    if (status) {
      where.status = status;
    }

    if (from || to) {
      where.queuedAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    }

    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { toAddress: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
      ];
    }

    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.email.findMany({
        where,
        select: EMAIL_LIST_SELECT,
        orderBy: { queuedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.email.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async detail(userId: string, publicId: string): Promise<EmailDetail> {
    const email = await this.prisma.email.findFirst({
      where: { publicId, userId },
      select: EMAIL_DETAIL_SELECT,
    });

    if (!email) {
      // Pas d'oracle : même 404 que l'email n'existe pas ou appartienne à
      // un autre utilisateur.
      throw new NotFoundException('Email introuvable');
    }

    return email;
  }

  private parseStatus(raw: string | undefined): EmailStatus | undefined {
    if (raw === undefined || raw === '') {
      return undefined;
    }

    const values = Object.values(EmailStatus) as string[];
    if (!values.includes(raw)) {
      throw new BadRequestException(`Statut inconnu : ${raw}`);
    }

    return raw as EmailStatus;
  }

  private parsePositiveInt(
    raw: string | undefined,
    field: string,
    fallback: number,
    max?: number,
  ): number {
    if (raw === undefined || raw === '') {
      return fallback;
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new BadRequestException(
        `${field} doit être un entier supérieur ou égal à 1`,
      );
    }

    if (max !== undefined && value > max) {
      throw new BadRequestException(
        `${field} doit être inférieur ou égal à ${max}`,
      );
    }

    return value;
  }

  private parseDateRange(
    fromRaw: string | undefined,
    toRaw: string | undefined,
  ): { from?: Date; to?: Date } {
    const from = this.parseDate(fromRaw, 'from');
    const to = this.parseDate(toRaw, 'to');

    if (from && to && from > to) {
      throw new BadRequestException('from doit être antérieur ou égal à to');
    }

    return { from, to };
  }

  private parseDate(raw: string | undefined, field: string): Date | undefined {
    if (raw === undefined || raw === '') {
      return undefined;
    }

    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        `${field} doit être une date ISO 8601 valide`,
      );
    }

    return date;
  }
}

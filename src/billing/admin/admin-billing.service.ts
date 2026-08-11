import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TopUpStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CREDIT_REASON_TOPUP,
  TOPUP_REQUEST_ALREADY_REVIEWED_MESSAGE,
  TOPUP_REQUEST_NOT_FOUND_MESSAGE,
} from '../billing.constants';
import type { RejectTopUpRequestDto } from './dto/reject-topup-request.dto';
import type {
  AdminTopUpRequestItem,
  AdminTopUpRequestReviewResult,
  RawAdminTopUpRequestsQuery,
} from './admin.types';

const ADMIN_TOPUP_REQUEST_SELECT = {
  id: true,
  user: { select: { id: true, email: true, name: true } },
  packId: true,
  credits: true,
  amountGnf: true,
  method: true,
  phoneNumber: true,
  transactionRef: true,
  status: true,
  createdAt: true,
};

/**
 * Revue admin des demandes de recharge Mobile Money (activation manuelle —
 * cahier §7.3, les API Orange Money / MTN MoMo ne sont pas disponibles).
 */
@Injectable()
export class AdminBillingService {
  constructor(private readonly prisma: PrismaService) {}

  async listTopUpRequests(
    query: RawAdminTopUpRequestsQuery,
  ): Promise<AdminTopUpRequestItem[]> {
    const status = this.parseStatus(query.status) ?? TopUpStatus.PENDING;

    return this.prisma.topUpRequest.findMany({
      where: { status },
      select: ADMIN_TOPUP_REQUEST_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Passe la demande en APPROVED et crédite le compte, dans la même
   * transaction : jamais de crédit sans demande approuvée, ni l'inverse.
   * Idempotent : une demande déjà traitée renvoie 409 sans second crédit.
   */
  async approve(
    id: string,
    adminId: string,
  ): Promise<AdminTopUpRequestReviewResult> {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.topUpRequest.findUnique({ where: { id } });

      if (!request) {
        throw new NotFoundException(TOPUP_REQUEST_NOT_FOUND_MESSAGE);
      }

      if (request.status !== TopUpStatus.PENDING) {
        throw new ConflictException(TOPUP_REQUEST_ALREADY_REVIEWED_MESSAGE);
      }

      const updated = await tx.topUpRequest.update({
        where: { id },
        data: {
          status: TopUpStatus.APPROVED,
          reviewedAt: new Date(),
          reviewedBy: adminId,
        },
        select: { id: true, status: true, userId: true, credits: true },
      });

      await tx.creditEntry.create({
        data: {
          userId: updated.userId,
          delta: updated.credits,
          reason: CREDIT_REASON_TOPUP,
          reference: updated.id,
        },
      });

      return { id: updated.id, status: updated.status };
    });
  }

  /** Rejette la demande, sans jamais créer de mouvement de crédit. */
  async reject(
    id: string,
    adminId: string,
    dto: RejectTopUpRequestDto,
  ): Promise<AdminTopUpRequestReviewResult> {
    const request = await this.prisma.topUpRequest.findUnique({
      where: { id },
    });

    if (!request) {
      throw new NotFoundException(TOPUP_REQUEST_NOT_FOUND_MESSAGE);
    }

    if (request.status !== TopUpStatus.PENDING) {
      throw new ConflictException(TOPUP_REQUEST_ALREADY_REVIEWED_MESSAGE);
    }

    const updated = await this.prisma.topUpRequest.update({
      where: { id },
      data: {
        status: TopUpStatus.REJECTED,
        reviewedAt: new Date(),
        reviewedBy: adminId,
        rejectionReason: dto.reason,
      },
      select: { id: true, status: true },
    });

    return updated;
  }

  private parseStatus(raw: string | undefined): TopUpStatus | undefined {
    if (raw === undefined || raw === '') {
      return undefined;
    }

    const values = Object.values(TopUpStatus) as string[];
    if (!values.includes(raw)) {
      throw new BadRequestException(`Statut inconnu : ${raw}`);
    }

    return raw as TopUpStatus;
  }
}

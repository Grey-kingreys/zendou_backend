import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { TopUpStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CREDIT_PACKS, findPack, type CreditPack } from './packs';
import {
  CREDIT_REASON_TOPUP,
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  DUPLICATE_TRANSACTION_REF_MESSAGE,
  INVALID_PHONE_MESSAGE,
  MAX_LIMIT,
  PACK_NOT_FOUND_MESSAGE,
  PACK_NOT_PURCHASABLE_MESSAGE,
  PHONE_ALLOWED_CHARS_REGEX,
  PHONE_MAX_DIGITS,
  PHONE_MIN_DIGITS,
} from './billing.constants';
import type { CreateTopUpRequestDto } from './dto/create-topup-request.dto';
import type {
  BalanceSummary,
  CreditEntryItem,
  PaginatedCreditEntries,
  RawEntriesListQuery,
  TopUpRequestItem,
} from './billing.types';

const CREDIT_ENTRY_SELECT = {
  delta: true,
  reason: true,
  reference: true,
  createdAt: true,
} satisfies Record<keyof CreditEntryItem, true>;

const TOPUP_REQUEST_SELECT = {
  id: true,
  packId: true,
  credits: true,
  amountGnf: true,
  method: true,
  phoneNumber: true,
  transactionRef: true,
  status: true,
  rejectionReason: true,
  createdAt: true,
} satisfies Record<keyof TopUpRequestItem, true>;

/**
 * Crédits et facturation côté client : solde, ledger, packs et demandes
 * de recharge Mobile Money (activation manuelle — cahier §7.3).
 */
@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Le solde et ses composantes sont dérivés du ledger, jamais stockés.
   *
   * `totalPurchased`/`totalGifted` reposent sur une **liste d'autorisation**,
   * pas une liste d'exclusion : la définition d'un crédit payé est fermée
   * (`reason === CREDIT_REASON_TOPUP`, le seul motif adossé à un encaissement
   * réel), celle d'un crédit offert est ouverte (tout le reste — crédit de
   * bienvenue, avoir admin, et tout futur motif gratuit). Un nouveau motif de
   * crédit gratuit tombe ainsi du bon côté par défaut, sans devoir être ajouté
   * à une liste d'exclusion au cas par cas. Identité conservée :
   * `balance = totalPurchased + totalGifted - totalConsumed`.
   */
  async getBalance(userId: string): Promise<BalanceSummary> {
    const [total, purchased, gifted, consumed] = await Promise.all([
      this.prisma.creditEntry.aggregate({
        where: { userId },
        _sum: { delta: true },
      }),
      this.prisma.creditEntry.aggregate({
        where: {
          userId,
          delta: { gt: 0 },
          reason: CREDIT_REASON_TOPUP,
        },
        _sum: { delta: true },
      }),
      this.prisma.creditEntry.aggregate({
        where: {
          userId,
          delta: { gt: 0 },
          reason: { not: CREDIT_REASON_TOPUP },
        },
        _sum: { delta: true },
      }),
      this.prisma.creditEntry.aggregate({
        where: { userId, delta: { lt: 0 } },
        _sum: { delta: true },
      }),
    ]);

    return {
      balance: total._sum.delta ?? 0,
      totalPurchased: purchased._sum.delta ?? 0,
      totalGifted: gifted._sum.delta ?? 0,
      totalConsumed: Math.abs(consumed._sum.delta ?? 0),
    };
  }

  async listEntries(
    userId: string,
    query: RawEntriesListQuery,
  ): Promise<PaginatedCreditEntries> {
    const page = this.parsePositiveInt(query.page, 'page', DEFAULT_PAGE);
    const limit = this.parsePositiveInt(
      query.limit,
      'limit',
      DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.creditEntry.findMany({
        where: { userId },
        select: CREDIT_ENTRY_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.creditEntry.count({ where: { userId } }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** Catalogue en dur (cahier §7.2) — pas de source base de données. */
  listPacks(): CreditPack[] {
    return [...CREDIT_PACKS];
  }

  /**
   * Enregistre une déclaration de paiement Mobile Money en attente de
   * validation manuelle par un admin. `credits`/`amountGnf` viennent
   * toujours du pack côté serveur, jamais du corps de la requête.
   */
  async createTopUpRequest(
    userId: string,
    dto: CreateTopUpRequestDto,
  ): Promise<TopUpRequestItem> {
    const pack = findPack(dto.packId);

    if (!pack) {
      throw new BadRequestException(PACK_NOT_FOUND_MESSAGE);
    }

    if (!pack.purchasable) {
      throw new BadRequestException(PACK_NOT_PURCHASABLE_MESSAGE);
    }

    if (!this.isValidPhoneNumber(dto.phoneNumber)) {
      throw new BadRequestException(INVALID_PHONE_MESSAGE);
    }

    // Pas d'oracle nécessaire ici : le doublon est scopé à l'appelant, la
    // référence Mobile Money d'un tiers ne fuite jamais.
    const duplicate = await this.prisma.topUpRequest.findFirst({
      where: {
        userId,
        transactionRef: dto.transactionRef,
        status: TopUpStatus.PENDING,
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new ConflictException(DUPLICATE_TRANSACTION_REF_MESSAGE);
    }

    return this.prisma.topUpRequest.create({
      data: {
        userId,
        packId: pack.id,
        credits: pack.credits,
        amountGnf: pack.amountGnf,
        method: dto.method,
        phoneNumber: dto.phoneNumber,
        transactionRef: dto.transactionRef,
      },
      select: TOPUP_REQUEST_SELECT,
    });
  }

  async listTopUpRequests(userId: string): Promise<TopUpRequestItem[]> {
    return this.prisma.topUpRequest.findMany({
      where: { userId },
      select: TOPUP_REQUEST_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Chiffres, espaces et « + » uniquement, avec 8 à 15 chiffres. */
  private isValidPhoneNumber(phone: string): boolean {
    if (!PHONE_ALLOWED_CHARS_REGEX.test(phone)) {
      return false;
    }

    const digitCount = (phone.match(/\d/g) ?? []).length;
    return digitCount >= PHONE_MIN_DIGITS && digitCount <= PHONE_MAX_DIGITS;
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
}

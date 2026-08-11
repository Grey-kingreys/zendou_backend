import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DomainStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isValidDomainName, normalizeDomainName } from './domain-name';
import {
  DOMAIN_ALREADY_REGISTERED_MESSAGE,
  DOMAIN_NOT_FOUND_MESSAGE,
  INVALID_DOMAIN_NAME_MESSAGE,
} from './domains.constants';
import type {
  DomainCheckResult,
  DomainDetail,
  DomainSummary,
} from './domains.types';
import { buildDkimRecords, buildRecommendedRecords } from './dns-records';
import {
  SES_IDENTITY_DRIVER,
  type SesIdentityDriver,
} from './ses/ses-identity-driver';

/** Colonnes chargées pour construire une réponse détaillée. */
const DOMAIN_SELECT = {
  id: true,
  name: true,
  status: true,
  dkimTokens: true,
  verifiedAt: true,
  createdAt: true,
} satisfies Prisma.DomainSelect;

/** Colonnes chargées pour la liste. */
const DOMAIN_SUMMARY_SELECT = {
  id: true,
  name: true,
  status: true,
  verifiedAt: true,
  createdAt: true,
} satisfies Prisma.DomainSelect;

type DomainRecord = DomainSummary & { dkimTokens: string[] };

@Injectable()
export class DomainsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SES_IDENTITY_DRIVER)
    private readonly sesDriver: SesIdentityDriver,
  ) {}

  /**
   * Enregistre un domaine, crée l'identité SES correspondante et retourne
   * les enregistrements DNS à publier.
   */
  async create(userId: string, rawName: string): Promise<DomainDetail> {
    const name = normalizeDomainName(rawName);

    if (!isValidDomainName(name)) {
      throw new BadRequestException(INVALID_DOMAIN_NAME_MESSAGE);
    }

    // Le domaine est unique globalement : un domaine déjà pris par un autre
    // client renvoie le même message neutre (pas de fuite d'information).
    const existing = await this.prisma.domain.findUnique({
      where: { name },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(DOMAIN_ALREADY_REGISTERED_MESSAGE);
    }

    const { dkimTokens } = await this.sesDriver.createIdentity(name);

    try {
      const domain = await this.prisma.domain.create({
        data: { userId, name, dkimTokens },
        select: DOMAIN_SELECT,
      });

      return toDetail(domain);
    } catch (error) {
      // Course entre deux enregistrements simultanés du même domaine.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(DOMAIN_ALREADY_REGISTERED_MESSAGE);
      }
      throw error;
    }
  }

  /** Liste les domaines du client courant, du plus récent au plus ancien. */
  async list(userId: string): Promise<DomainSummary[]> {
    return this.prisma.domain.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: DOMAIN_SUMMARY_SELECT,
    });
  }

  /** Détail d'un domaine du client courant, avec les enregistrements DNS. */
  async findOne(userId: string, id: string): Promise<DomainDetail> {
    return toDetail(await this.requireOwnedDomain(userId, id));
  }

  /**
   * Interroge SES et met à jour le statut local. `verifiedAt` est horodaté
   * au premier passage à `VERIFIED`.
   */
  async check(userId: string, id: string): Promise<DomainCheckResult> {
    const domain = await this.requireOwnedDomain(userId, id);
    const status = await this.sesDriver.getIdentityStatus(domain.name);

    const verifiedAt =
      status === DomainStatus.VERIFIED
        ? (domain.verifiedAt ?? new Date())
        : domain.verifiedAt;

    return this.prisma.domain.update({
      where: { id: domain.id },
      data: { status, verifiedAt },
      select: { id: true, status: true, verifiedAt: true },
    });
  }

  /** Supprime l'identité SES puis le domaine. */
  async remove(userId: string, id: string): Promise<void> {
    const domain = await this.requireOwnedDomain(userId, id);

    await this.sesDriver.deleteIdentity(domain.name);
    await this.prisma.domain.delete({ where: { id: domain.id } });
  }

  /**
   * Charge un domaine en le restreignant au propriétaire : le domaine d'un
   * autre client est traité comme inexistant.
   */
  private async requireOwnedDomain(
    userId: string,
    id: string,
  ): Promise<DomainRecord> {
    const domain = await this.prisma.domain.findFirst({
      where: { id, userId },
      select: DOMAIN_SELECT,
    });

    if (!domain) {
      throw new NotFoundException(DOMAIN_NOT_FOUND_MESSAGE);
    }

    return domain;
  }
}

function toDetail(domain: DomainRecord): DomainDetail {
  const { dkimTokens, ...summary } = domain;

  return {
    ...summary,
    dkimRecords: buildDkimRecords(summary.name, dkimTokens),
    recommendedRecords: buildRecommendedRecords(summary.name),
  };
}

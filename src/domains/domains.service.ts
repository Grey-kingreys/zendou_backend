import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isValidDomainName, normalizeDomainName } from './domain-name';
import {
  DEFAULT_AWS_REGION,
  DOMAIN_ALREADY_REGISTERED_MESSAGE,
  DOMAIN_NOT_FOUND_MESSAGE,
  INVALID_DOMAIN_NAME_MESSAGE,
  mailFromDomainOf,
} from './domains.constants';
import { checkDomainDns, type DomainDnsCheckResult } from './dns-check';
import type {
  DomainCheckResult,
  DomainDetail,
  DomainSummary,
} from './domains.types';
import { buildDkimRecords, buildRecommendedRecords } from './dns-records';
import {
  SES_IDENTITY_DRIVER,
  type MailFromStatus,
  type SesIdentityDriver,
} from './ses/ses-identity-driver';

/** Colonnes chargées pour construire une réponse détaillée. */
const DOMAIN_SELECT = {
  id: true,
  name: true,
  status: true,
  dkimTokens: true,
  mailFromStatus: true,
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

type DomainRecord = DomainSummary & {
  dkimTokens: string[];
  mailFromStatus: string | null;
};

@Injectable()
export class DomainsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SES_IDENTITY_DRIVER)
    private readonly sesDriver: SesIdentityDriver,
    private readonly configService: ConfigService,
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

      return this.toDetail(domain);
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
    return this.toDetail(await this.requireOwnedDomain(userId, id));
  }

  /**
   * Interroge SES et met à jour le statut local. `verifiedAt` est horodaté
   * au premier passage à `VERIFIED`. Le statut du MAIL FROM personnalisé est
   * relu au passage (et posé côté SES s'il manquait, voir le driver).
   */
  async check(userId: string, id: string): Promise<DomainCheckResult> {
    const domain = await this.requireOwnedDomain(userId, id);
    const { status, mailFromStatus } = await this.sesDriver.getIdentityStatus(
      domain.name,
    );

    const verifiedAt =
      status === DomainStatus.VERIFIED
        ? (domain.verifiedAt ?? new Date())
        : domain.verifiedAt;

    const updated = await this.prisma.domain.update({
      where: { id: domain.id },
      // Un statut MAIL FROM illisible (panne SES) ne remplace pas le dernier connu.
      data: {
        status,
        verifiedAt,
        ...(mailFromStatus ? { mailFromStatus } : {}),
      },
      select: {
        id: true,
        status: true,
        verifiedAt: true,
        mailFromStatus: true,
      },
    });

    return {
      ...updated,
      mailFromStatus: toMailFromStatus(updated.mailFromStatus),
    };
  }

  /**
   * Diagnostic DNS des enregistrements DKIM/SPF/DMARC, calculé côté Zendou
   * par résolution DNS directe — indépendant de SES, purement informatif
   * (voir la documentation de `checkDomainDns`). N'appelle jamais SES et ne
   * modifie rien en base : c'est une lecture pure.
   */
  async dnsCheck(userId: string, id: string): Promise<DomainDnsCheckResult> {
    const domain = await this.requireOwnedDomain(userId, id);

    return checkDomainDns(
      { ...domain, mailFromStatus: toMailFromStatus(domain.mailFromStatus) },
      this.sesRegion(),
    );
  }

  /** Supprime l'identité SES puis le domaine. */
  async remove(userId: string, id: string): Promise<void> {
    const domain = await this.requireOwnedDomain(userId, id);

    await this.sesDriver.deleteIdentity(domain.name);
    await this.prisma.domain.delete({ where: { id: domain.id } });
  }

  /**
   * Détruit l'identité SES d'un domaine dont la ligne a déjà été supprimée
   * par ailleurs (anonymisation d'un compte, ANON-1). Même appel au même
   * driver que {@link remove} : la seule différence est que la ligne `Domain`
   * n'existe plus, donc aucun contrôle de propriétaire n'est possible ici.
   * Lève si SES échoue : l'appelant doit le dire, jamais l'avaler.
   */
  async deleteSesIdentity(name: string): Promise<void> {
    await this.sesDriver.deleteIdentity(name);
  }

  /** Région SES configurée, la même que celle du driver. */
  private sesRegion(): string {
    return (
      (this.configService.get<string>('AWS_REGION') ?? '').trim() ||
      DEFAULT_AWS_REGION
    );
  }

  private toDetail(domain: DomainRecord): DomainDetail {
    const { dkimTokens, mailFromStatus, ...summary } = domain;

    return {
      ...summary,
      mailFromDomain: mailFromDomainOf(summary.name),
      mailFromStatus: toMailFromStatus(mailFromStatus),
      dkimRecords: buildDkimRecords(summary.name, dkimTokens),
      recommendedRecords: buildRecommendedRecords(
        summary.name,
        this.sesRegion(),
      ),
    };
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

/** Colonne texte -> statut SES connu ; toute autre valeur est ignorée. */
function toMailFromStatus(
  value: string | null | undefined,
): MailFromStatus | null {
  return value === 'PENDING' ||
    value === 'SUCCESS' ||
    value === 'FAILED' ||
    value === 'TEMPORARY_FAILURE'
    ? value
    : null;
}

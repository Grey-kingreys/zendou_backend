import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveReadScope } from './credential-scope';
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
  DomainRemoveResult,
  DomainSummary,
  DomainUsage,
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
  private readonly logger = new Logger(DomainsService.name);

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
  async list(userId: string, apiKeyId?: string): Promise<DomainSummary[]> {
    // Lecture par clé API : seuls les domaines de sa portée (B27).
    const scope = await resolveReadScope(this.prisma, apiKeyId);

    return this.prisma.domain.findMany({
      where: { userId, ...(scope ? { id: { in: scope } } : {}) },
      orderBy: { createdAt: 'desc' },
      select: DOMAIN_SUMMARY_SELECT,
    });
  }

  /** Détail d'un domaine du client courant, avec les enregistrements DNS. */
  async findOne(
    userId: string,
    id: string,
    apiKeyId?: string,
  ): Promise<DomainDetail> {
    // Hors de la portée de la clé : 404, comme si le domaine n'existait pas.
    const scope = await resolveReadScope(this.prisma, apiKeyId);

    if (scope && !scope.includes(id)) {
      throw new NotFoundException(DOMAIN_NOT_FOUND_MESSAGE);
    }

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

  /**
   * Aperçu d'impact d'une suppression (B27) : les clés API et identifiants
   * SMTP actifs liés à ce domaine, avec `willBeRevoked` quand c'est leur
   * dernier. Lecture pure ; 404 si le domaine n'est pas au compte.
   */
  async usage(userId: string, id: string): Promise<DomainUsage> {
    const domain = await this.requireOwnedDomain(userId, id);

    return this.readUsage(this.prisma, domain.id);
  }

  /**
   * Supprime le domaine, puis son identité SES. Dans une seule transaction :
   * les liens de portée du domaine sont retirés, et toute clé ou tout
   * identifiant qui perd ainsi son DERNIER domaine est révoqué - jamais élargi
   * à tous les domaines (B27). Ceux qui gardent d'autres domaines les
   * conservent. Rend ce qui a été révoqué.
   *
   * L'identité SES n'est détruite qu'APRÈS le commit, comme le fait
   * l'anonymisation : si la transaction échoue (clé liée au même instant,
   * FK `Restrict`), le domaine reste entier, identité SES comprise. Si SES
   * échoue après le commit, la base est déjà à jour : l'erreur est journalisée
   * et signalée dans `remainingActions`, la suppression ne rend pas d'erreur.
   */
  async remove(userId: string, id: string): Promise<DomainRemoveResult> {
    const domain = await this.requireOwnedDomain(userId, id);

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Verrouille les clés et identifiants liés AVANT de compter leurs liens.
      // Sans cela, deux suppressions simultanées de deux domaines d'une même
      // clé lisent chacune deux liens et aucune ne la révoque (READ COMMITTED).
      // Avec le verrou, la seconde attend la première, puis recompte. Tri par
      // `id` : ordre de prise de verrou identique partout, donc pas d'interblocage.
      await tx.$queryRaw`SELECT k."id" FROM "ApiKey" k JOIN "ApiKeyDomain" l ON l."apiKeyId" = k."id" WHERE l."domainId" = ${domain.id} ORDER BY k."id" FOR UPDATE OF k`;
      await tx.$queryRaw`SELECT c."id" FROM "SmtpCredential" c JOIN "SmtpCredentialDomain" l ON l."smtpCredentialId" = c."id" WHERE l."domainId" = ${domain.id} ORDER BY c."id" FOR UPDATE OF c`;

      const usage = await this.readUsage(tx, domain.id);
      const revokedApiKeys = usage.apiKeys
        .filter((apiKey) => apiKey.willBeRevoked)
        .map(({ id: keyId, name, prefix }) => ({ id: keyId, name, prefix }));
      const revokedSmtpCredentials = usage.smtpCredentials
        .filter((credential) => credential.willBeRevoked)
        .map(({ id: credentialId, name, username, prefix }) => ({
          id: credentialId,
          name,
          username,
          prefix,
        }));
      const revokedAt = new Date();

      if (revokedApiKeys.length > 0) {
        await tx.apiKey.updateMany({
          where: { id: { in: revokedApiKeys.map((apiKey) => apiKey.id) } },
          data: { revokedAt },
        });
      }

      if (revokedSmtpCredentials.length > 0) {
        await tx.smtpCredential.updateMany({
          where: {
            id: {
              in: revokedSmtpCredentials.map((credential) => credential.id),
            },
          },
          data: { revokedAt },
        });
      }

      // Tous les liens du domaine, y compris ceux des clés déjà révoquées : la
      // clé étrangère vers `Domain` est en `Restrict`.
      await tx.apiKeyDomain.deleteMany({ where: { domainId: domain.id } });
      await tx.smtpCredentialDomain.deleteMany({
        where: { domainId: domain.id },
      });
      await tx.domain.delete({ where: { id: domain.id } });

      return { revokedApiKeys, revokedSmtpCredentials };
    });

    const remainingActions: string[] = [];

    try {
      await this.sesDriver.deleteIdentity(domain.name);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Suppression de ${domain.name} : identité SES non supprimée (${detail})`,
      );
      remainingActions.push(
        `Supprimer à la main l'identité SES du domaine ${domain.name} (échec de l'appel SES : ${detail}).`,
      );
    }

    return { ...outcome, remainingActions };
  }

  /**
   * Clés API et identifiants SMTP actifs liés à un domaine. `_count.domains`
   * vaut 1 quand ce domaine est le seul de la portée : c'est ce qui fait
   * dire `willBeRevoked`.
   */
  private async readUsage(
    client: PrismaService | Prisma.TransactionClient,
    domainId: string,
  ): Promise<DomainUsage> {
    const [apiKeyLinks, credentialLinks] = await Promise.all([
      client.apiKeyDomain.findMany({
        where: { domainId, apiKey: { revokedAt: null } },
        select: {
          apiKey: {
            select: {
              id: true,
              name: true,
              prefix: true,
              _count: { select: { domains: true } },
            },
          },
        },
        orderBy: { apiKey: { name: 'asc' } },
      }),
      client.smtpCredentialDomain.findMany({
        where: { domainId, smtpCredential: { revokedAt: null } },
        select: {
          smtpCredential: {
            select: {
              id: true,
              name: true,
              username: true,
              prefix: true,
              _count: { select: { domains: true } },
            },
          },
        },
        orderBy: { smtpCredential: { name: 'asc' } },
      }),
    ]);

    return {
      apiKeys: apiKeyLinks.map(({ apiKey }) => ({
        id: apiKey.id,
        name: apiKey.name,
        prefix: apiKey.prefix,
        willBeRevoked: apiKey._count.domains === 1,
      })),
      smtpCredentials: credentialLinks.map(({ smtpCredential }) => ({
        id: smtpCredential.id,
        name: smtpCredential.name,
        username: smtpCredential.username,
        prefix: smtpCredential.prefix,
        willBeRevoked: smtpCredential._count.domains === 1,
      })),
    };
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

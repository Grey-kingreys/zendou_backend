import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AdminActionType, Prisma, UserRole, UserStatus } from '@prisma/client';
import { SessionService } from '../auth';
import { ACTIVE_CREDIT_ENTRY_WHERE } from '../billing/billing.constants';
import { DomainsService } from '../domains/domains.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_ANONYMIZE_MESSAGE,
  ALREADY_ANONYMIZED_MESSAGE,
  ANONYMIZED_FOR_INACTIVITY_REASON,
  ANONYMIZED_NAME,
  ANONYMIZED_ON_REQUEST_REASON,
  SELF_ANONYMIZE_MESSAGE,
  anonymizedEmail,
  maskPhoneNumber,
} from './account-lifecycle.constants';

/** Message 404, identique à celui des autres routes admin. */
const USER_NOT_FOUND_MESSAGE = 'Utilisateur introuvable.';

/**
 * Origine d'une anonymisation.
 *
 * - `admin` : demande d'effacement traitée par un administrateur, tracée dans
 *   `AdminAction` (`ANONYMIZE_USER`).
 * - `inactivity` : traitement automatique des comptes inactifs. Aucune ligne
 *   `AdminAction` (sa colonne `adminId` est obligatoire et aucun admin n'a
 *   agi) : la trace est le motif de suspension posé sur le compte et le
 *   journal applicatif. Les deux bornes sont revérifiées **dans** la
 *   transaction : un compte redevenu actif entre la recherche et
 *   l'anonymisation est épargné.
 */
export type AnonymizationOrigin =
  | { kind: 'admin'; adminId: string }
  | {
      kind: 'inactivity';
      /** Dernière activité exigée au plus tard à cette date. */
      inactiveSince: Date;
      /** Avertissement exigé au plus tard à cette date. */
      warnedBefore: Date;
    };

/** Résultat d'une anonymisation. */
export interface AnonymizationResult {
  anonymizedAt: Date;
  /**
   * Ce qui n'a pas pu être fait hors de la base et reste à faire à la main
   * (identité SES non détruite, sessions non révoquées). Vide quand tout est
   * fait. Jamais avalé : c'est la réponse de la route admin qui le porte.
   */
  remainingActions: string[];
}

/**
 * Anonymisation d'un compte (ANON-1) : efface les données personnelles et
 * conserve les traces de paiement (`CreditEntry`, `TopUpRequest`) pour la
 * comptabilité, comme le promet la politique de confidentialité.
 *
 * En une transaction : suppression des domaines, clés API, identifiants SMTP,
 * des lignes `Suppression` propres au compte (elles portent son adresse
 * d'origine et celles de ses destinataires, rattachées à son id ; le compte ne
 * pouvant plus envoyer, elles ne protègent plus rien), masquage du numéro
 * Mobile Money et effacement du motif de refus des demandes de recharge,
 * et lignes `Email` (adresses de destinataires = données de tiers ; le corps
 * n'est jamais stocké), réécriture du compte, ligne d'audit. Puis, hors de la
 * transaction et seulement après son succès : destruction des identités SES
 * des domaines et révocation des sessions. Un échec à ce stade ne défait rien
 * (la base est déjà anonymisée) et remonte dans `remainingActions`.
 */
@Injectable()
export class AccountAnonymizationService {
  private readonly logger = new Logger(AccountAnonymizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
    private readonly domainsService: DomainsService,
  ) {}

  /**
   * Anonymise le compte `userId`.
   *
   * Refus (origine `admin`) : soi-même 400, compte ADMIN 409, déjà anonymisé
   * 409, inconnu 404. Origine `inactivity` : un compte qui n'est plus
   * éligible renvoie `null`, sans rien écrire.
   */
  async anonymize(
    userId: string,
    origin: AnonymizationOrigin,
  ): Promise<AnonymizationResult | null> {
    // 400 comme les autres refus de soi (suspension, crédit, suppression).
    if (origin.kind === 'admin' && origin.adminId === userId) {
      throw new BadRequestException(SELF_ANONYMIZE_MESSAGE);
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, anonymizedAt: true },
      });

      if (!user) {
        throw new NotFoundException(USER_NOT_FOUND_MESSAGE);
      }

      // Traitement automatique : un compte devenu inéligible (promu admin,
      // déjà anonymisé) est simplement ignoré, ce n'est pas une erreur.
      if (
        origin.kind === 'inactivity' &&
        (user.role === UserRole.ADMIN || user.anonymizedAt !== null)
      ) {
        return null;
      }

      if (user.role === UserRole.ADMIN) {
        throw new ConflictException(ADMIN_ANONYMIZE_MESSAGE);
      }

      if (user.anonymizedAt !== null) {
        throw new ConflictException(ALREADY_ANONYMIZED_MESSAGE);
      }

      const anonymizedAt = new Date();

      // Réécriture du compte **en premier**, et conditionnelle : la ligne
      // est verrouillée jusqu'à la fin de la transaction, donc une connexion
      // ou un envoi concurrent (qui écrit `lastActivityAt`) attend puis
      // constate `anonymizedAt` posé, et une seconde anonymisation
      // concurrente ne trouve plus rien à réécrire. Pour le traitement des
      // inactifs, les conditions d'éligibilité sont dans le `where` : un
      // compte redevenu actif depuis la recherche n'est pas touché.
      const rewritten = await tx.user.updateMany({
        where: {
          id: userId,
          anonymizedAt: null,
          role: UserRole.CUSTOMER,
          ...(origin.kind === 'inactivity' ? eligibilityWhere(origin) : {}),
        },
        data: {
          email: anonymizedEmail(userId),
          name: ANONYMIZED_NAME,
          company: null,
          declaredUsage: null,
          passwordHash: null,
          googleSub: null,
          emailVerificationTokenHash: null,
          emailVerificationSentTo: null,
          emailVerificationExpiresAt: null,
          status: UserStatus.SUSPENDED,
          suspendedAt: anonymizedAt,
          suspensionReason:
            origin.kind === 'admin'
              ? ANONYMIZED_ON_REQUEST_REASON
              : ANONYMIZED_FOR_INACTIVITY_REASON,
          anonymizedAt,
          inactivityWarningSentAt: null,
        },
      });

      if (rewritten.count === 0) {
        if (origin.kind === 'inactivity') {
          return null;
        }
        // Anonymisation concurrente passée entre la lecture et l'écriture.
        throw new ConflictException(ALREADY_ANONYMIZED_MESSAGE);
      }

      const domains = await tx.domain.findMany({
        where: { userId },
        select: { name: true },
      });

      // Ordre : `Email` d'abord (sa clé vers `SmtpCredential` est en
      // `SetNull`, inutile de la faire travailler), puis les moyens d'envoi,
      // puis les domaines.
      await tx.email.deleteMany({ where: { userId } });
      await tx.apiKey.deleteMany({ where: { userId } });
      await tx.smtpCredential.deleteMany({ where: { userId } });
      await tx.domain.deleteMany({ where: { userId } });
      // Seulement les lignes rattachées à ce compte : les suppressions
      // globales (`userId` nul) et celles des autres comptes restent.
      await tx.suppression.deleteMany({ where: { userId } });

      // Traces de paiement conservées pour la comptabilité, mais sans ce
      // qui identifie le payeur : numéro Mobile Money masqué, motif de refus
      // (texte libre de l'admin) effacé. Montants, pack, méthode, référence
      // opérateur et dates restent.
      const topUps = await tx.topUpRequest.findMany({
        where: { userId },
        select: { id: true, phoneNumber: true },
      });
      for (const topUp of topUps) {
        await tx.topUpRequest.update({
          where: { id: topUp.id },
          data: {
            phoneNumber: maskPhoneNumber(topUp.phoneNumber),
            rejectionReason: null,
          },
        });
      }

      if (origin.kind === 'admin') {
        // Ni l'email ni le nom d'origine : le but est d'effacer. La cible
        // (`targetUserId`) et la date suffisent à retrouver l'opération.
        await tx.adminAction.create({
          data: {
            adminId: origin.adminId,
            targetUserId: userId,
            type: AdminActionType.ANONYMIZE_USER,
            details: {
              anonymizedUserId: userId,
              anonymizedAt: anonymizedAt.toISOString(),
            } satisfies Prisma.InputJsonObject,
          },
          select: { id: true },
        });
      }

      return { anonymizedAt, domainNames: domains.map((d) => d.name) };
    });

    if (outcome === null) {
      return null;
    }

    const remainingActions: string[] = [];

    for (const name of outcome.domainNames) {
      try {
        await this.domainsService.deleteSesIdentity(name);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Anonymisation de ${userId} : identité SES ${name} non supprimée (${detail})`,
        );
        remainingActions.push(
          `Supprimer à la main l'identité SES du domaine ${name} (échec de l'appel SES : ${detail}).`,
        );
      }
    }

    try {
      await this.sessionService.destroyAllForUser(userId);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Anonymisation de ${userId} : révocation des sessions en échec (${detail})`,
      );
      remainingActions.push(
        `Révoquer les sessions du compte ${userId} (échec Redis : ${detail}). En attendant, le compte est suspendu : chaque requête de ces sessions est refusée en 403.`,
      );
    }

    this.logger.log(
      `Compte ${userId} anonymisé (${origin.kind === 'admin' ? `par l'admin ${origin.adminId}` : 'inactivité'})` +
        (remainingActions.length > 0
          ? `, ${remainingActions.length} action(s) restante(s)`
          : ''),
    );

    return { anonymizedAt: outcome.anonymizedAt, remainingActions };
  }
}

/**
 * Conditions du traitement des comptes inactifs, revérifiées au moment
 * d'écrire : dernière activité assez ancienne (à défaut `createdAt`, jamais
 * « inactif depuis toujours ») et avertissement envoyé depuis assez
 * longtemps.
 */
function eligibilityWhere(origin: {
  inactiveSince: Date;
  warnedBefore: Date;
}): Prisma.UserWhereInput {
  return {
    inactivityWarningSentAt: { not: null, lte: origin.warnedBefore },
    // Compte devenu protégé depuis la recherche : jamais réécrit.
    creditEntries: { none: ACTIVE_CREDIT_ENTRY_WHERE },
    OR: [
      { lastActivityAt: { lte: origin.inactiveSince } },
      { lastActivityAt: null, createdAt: { lte: origin.inactiveSince } },
    ],
  };
}

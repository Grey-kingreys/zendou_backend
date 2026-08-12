import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailsService } from '../emails/emails.service';
import { isAddressSuppressed } from '../emails/suppressions';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALREADY_CONFIRMED_MESSAGE,
  CONFIRMATION_EMAIL_SUBJECT,
  CONFIRMATION_EMAIL_UNAVAILABLE_MESSAGE,
  EMAIL_CONFIRMATION_TOKEN_BYTES,
  EMAIL_CONFIRMATION_TTL_HOURS,
  INVALID_CONFIRMATION_TOKEN_MESSAGE,
  SUPPRESSED_ADDRESS_MESSAGE,
} from './email-confirmation.constants';
import {
  buildConfirmationEmail,
  buildConfirmationUrl,
} from './confirmation-email.template';

const HOUR_MS = 60 * 60 * 1000;

/** Réponse de `POST /v1/auth/confirm-email`. */
export interface ConfirmEmailResult {
  confirmed: true;
  /**
   * Crédits réellement accordés par cet appel. Le champ appartient au contrat
   * de la route dès maintenant : la confirmation est le seul moment où des
   * crédits pourront être accordés, et l'ajouter plus tard casserait les
   * clients déjà écrits. Aucun octroi n'est encore branché, la valeur est donc
   * toujours `0`.
   */
  creditsGranted: number;
}

/** Réponse de `POST /v1/auth/resend-confirmation`. */
export interface ResendConfirmationResult {
  sent: true;
}

/**
 * Confirmation de l'adresse email et crédit de bienvenue.
 *
 * Le jeton n'existe en clair que dans l'email : la base ne conserve que son
 * empreinte SHA-256, comme pour les clés API. Une fuite de la base ne donne
 * donc aucun jeton utilisable.
 */
@Injectable()
export class EmailConfirmationService {
  private readonly logger = new Logger(EmailConfirmationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailsService: EmailsService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Émet un jeton et expédie le lien. Appelée à l'inscription (au mieux : un
   * échec d'envoi ne doit pas faire échouer la création du compte) et par
   * `resend` (où l'échec, lui, est remonté).
   */
  async issueAndSend(
    userId: string,
    email: string,
    name: string,
  ): Promise<void> {
    const token = await this.issueToken(userId, email);
    const url = buildConfirmationUrl(this.appBaseUrl(), token);
    const { html, text } = buildConfirmationEmail(name, url);

    const result = await this.emailsService.sendSystem({
      userId,
      to: email,
      subject: CONFIRMATION_EMAIL_SUBJECT,
      html,
      text,
    });

    if (result.status === 'suppressed') {
      // Défense en profondeur : `resend` a déjà filtré ce cas en amont pour
      // pouvoir répondre 422. Ici on ne fait que tracer — à l'inscription, il
      // n'y a personne à qui répondre.
      this.logger.warn(
        `Lien de confirmation non expédié à l'utilisateur ${userId} : adresse sur la liste de suppression`,
      );
    }
  }

  /**
   * Renvoi du lien, sur demande d'un utilisateur connecté.
   *
   * Ordre volontaire : « déjà confirmé » (409) avant « adresse bloquée » (422)
   * avant l'émission d'un nouveau jeton. On n'invalide jamais le jeton en
   * cours pour un renvoi qui ne partira pas.
   */
  async resend(userId: string): Promise<ResendConfirmationResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, emailVerifiedAt: true },
    });

    if (!user) {
      throw new BadRequestException(INVALID_CONFIRMATION_TOKEN_MESSAGE);
    }

    if (user.emailVerifiedAt) {
      throw new ConflictException(ALREADY_CONFIRMED_MESSAGE);
    }

    // 422 : l'adresse a déjà provoqué un rebond dur ou une plainte. Lui
    // réexpédier un lien serait au mieux inutile, au pire une nouvelle
    // dégradation de la réputation du compte SES. L'utilisateur doit
    // apprendre que son adresse est invalide, pas attendre un email.
    if (await isAddressSuppressed(this.prisma, user.id, user.email)) {
      throw new UnprocessableEntityException(SUPPRESSED_ADDRESS_MESSAGE);
    }

    try {
      await this.issueAndSend(user.id, user.email, user.name);
    } catch (error) {
      // Configuration d'expédition inutilisable : répondre `sent: true`
      // serait un mensonge. On trace le détail et on renvoie un 503 neutre.
      this.logger.error(
        `Renvoi du lien de confirmation impossible pour l'utilisateur ${user.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(
        CONFIRMATION_EMAIL_UNAVAILABLE_MESSAGE,
      );
    }

    return { sent: true };
  }

  /**
   * Confirme l'adresse à partir du jeton reçu, et accorde le crédit de
   * bienvenue — une seule fois par compte, quoi qu'il arrive.
   *
   * Tout tient dans une transaction, et les deux écritures décisives sont des
   * `updateMany` conditionnels (`… WHERE colonne IS NULL`) : c'est la base qui
   * arbitre, pas une lecture suivie d'une écriture. Deux appels simultanés sur
   * le même jeton — double-clic, préchargement de lien par un antivirus de
   * messagerie, rejeu — n'en voient qu'un seul passer.
   */
  async confirm(token: string): Promise<ConfirmEmailResult> {
    const tokenHash = hashConfirmationToken(token);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { emailVerificationTokenHash: tokenHash },
        select: {
          id: true,
          email: true,
          emailVerifiedAt: true,
          emailVerificationSentTo: true,
          emailVerificationExpiresAt: true,
        },
      });

      // Jeton inconnu, ou remplacé par un renvoi ultérieur.
      if (!user) {
        throw new BadRequestException(INVALID_CONFIRMATION_TOKEN_MESSAGE);
      }

      // 409, et non 400 : le compte existe et il est en règle. C'est la seule
      // raison pour laquelle l'empreinte est conservée après confirmation —
      // sans elle, un rejeu du lien répondrait « lien invalide » à quelqu'un
      // dont le compte est parfaitement confirmé.
      if (user.emailVerifiedAt) {
        throw new ConflictException(ALREADY_CONFIRMED_MESSAGE);
      }

      // Le jeton est lié à l'adresse pour laquelle il a été émis. Si l'adresse
      // du compte a changé depuis, il ne vaut plus rien — et cela reste vrai
      // quel que soit le code qui l'aura changée un jour : il n'a rien à
      // invalider, l'invariant est porté par la donnée.
      if (user.emailVerificationSentTo !== user.email) {
        throw new BadRequestException(INVALID_CONFIRMATION_TOKEN_MESSAGE);
      }

      if (
        !user.emailVerificationExpiresAt ||
        user.emailVerificationExpiresAt.getTime() <= Date.now()
      ) {
        throw new BadRequestException(INVALID_CONFIRMATION_TOKEN_MESSAGE);
      }

      const now = new Date();

      // Usage unique : seule la transaction qui fait basculer `emailVerifiedAt`
      // de NULL à une date poursuit. Une seconde, concurrente, compte 0.
      const confirmed = await tx.user.updateMany({
        where: { id: user.id, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });

      if (confirmed.count === 0) {
        throw new ConflictException(ALREADY_CONFIRMED_MESSAGE);
      }

      this.logger.log(`Adresse confirmée pour l'utilisateur ${user.id}`);

      return { confirmed: true as const, creditsGranted: 0 };
    });
  }

  /**
   * Écrit un nouveau jeton sur le compte et retourne sa valeur en clair —
   * la seule fois où elle existe hors de l'email.
   *
   * Écrase l'éventuel jeton précédent : un seul lien vivant à la fois, un
   * renvoi périme celui d'avant.
   */
  private async issueToken(userId: string, email: string): Promise<string> {
    const token = randomBytes(EMAIL_CONFIRMATION_TOKEN_BYTES).toString(
      'base64url',
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerificationTokenHash: hashConfirmationToken(token),
        emailVerificationSentTo: email,
        emailVerificationExpiresAt: new Date(
          Date.now() + EMAIL_CONFIRMATION_TTL_HOURS * HOUR_MS,
        ),
      },
    });

    return token;
  }

  /** Base des liens : `APP_BASE_URL`, à défaut `FRONTEND_ORIGIN`. */
  private appBaseUrl(): string {
    const configured = (
      this.configService.get<string>('APP_BASE_URL') ?? ''
    ).trim();

    return (
      configured || (this.configService.get<string>('FRONTEND_ORIGIN') ?? '')
    );
  }
}

/**
 * Empreinte SHA-256 (hex) d'un jeton de confirmation — même fonction que pour
 * les clés API, et pour la même raison : la base ne doit jamais contenir de
 * secret en clair.
 */
export function hashConfirmationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

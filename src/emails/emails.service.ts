import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
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
  SYSTEM_SENDER_UNAVAILABLE_MESSAGE,
  TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE,
} from './emails.constants';
import type {
  EmailSendJobData,
  SendEmailResponse,
  SystemEmailPayload,
  SystemSendResult,
} from './emails.types';
import type { SendEmailDto } from './dto/send-email.dto';
import { isAddressSuppressed } from './suppressions';

/**
 * Échec d'un envoi système imputable à la configuration du serveur, jamais au
 * client : `SYSTEM_EMAIL_FROM` absente/illisible, ou domaine d'expédition non
 * vérifié. Distincte des exceptions HTTP pour que chaque appelant choisisse sa
 * traduction (503 sur une route explicite, simple log sur une inscription).
 */
export class SystemSenderUnavailableError extends Error {
  constructor(detail: string) {
    super(`${SYSTEM_SENDER_UNAVAILABLE_MESSAGE} (${detail})`);
    this.name = 'SystemSenderUnavailableError';
  }
}

@Injectable()
export class EmailsService {
  private readonly logger = new Logger(EmailsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EMAIL_SEND_QUEUE)
    private readonly queue: Queue<EmailSendJobData>,
    private readonly configService: ConfigService,
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

    // Mode bac à sable (B20) : reconnu au seul rapprochement d'adresse, sans
    // se soucier du nom d'affichage — un client peut envoyer
    // « Ma Boutique <adresse-de-test> » et rester dans ce mode.
    const domainId = this.isTestSenderAddress(from.address)
      ? await this.requireOwnAddressAsRecipient(userId, toAddress)
      : await this.requireVerifiedDomain(userId, from.domain);
    const fromAddress = formatEmailAddress(from);
    const common = {
      userId,
      domainId,
      fromAddress,
      toAddress,
      subject: dto.subject,
      // Explicite (plutôt que de compter sur le défaut du schéma) : un envoi
      // de test reste un envoi **client** ordinaire — compté dans la
      // réputation, le quota journalier, le journal et les KPI — jamais
      // traité comme `EmailsService.sendSystem`. Détourner cette exemption
      // rouvrirait exactement les protections anti-abus bâties en T12.
      system: false,
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
   * Envoi émis par Zendou lui-même (confirmation d'adresse aujourd'hui).
   *
   * Même chemin que l'envoi client — même file BullMQ, même worker, même
   * driver SES, donc même DKIM et même configuration set. Ce qui change tient
   * en une liste courte, volontairement énumérée ici plutôt que dissoute dans
   * un drapeau « ignore les règles ». Ce sont les garde-fous bâtis en T12 que
   * l'on contourne : la liste ci-dessous est le périmètre exact du
   * contournement.
   *
   * **Ce que l'exemption contourne** (et rien d'autre) :
   * 1. *Débit de crédits* — aucune `CreditEntry` n'est écrite. On ne facture
   *    pas au client un email qu'on lui envoie de notre propre initiative.
   * 2. *Solde de crédits* — pas d'`assertSufficientCredits` : un compte à zéro
   *    doit pouvoir recevoir son lien de confirmation, sinon il ne peut jamais
   *    obtenir le crédit de bienvenue qui suit la confirmation.
   * 3. *Quota journalier* — pas d'`assertDailyLimitNotReached`, et la ligne est
   *    exclue du comptage (`system: false` dans la requête). Un client qui a
   *    consommé ses 200 envois du jour doit quand même recevoir nos messages.
   * 4. *Propriété du domaine d'expédition* — `SYSTEM_EMAIL_FROM` appartient à
   *    Zendou, pas au destinataire : on ne peut pas exiger que le domaine soit
   *    l'un des siens. La vérification de propriété est donc levée ; la
   *    vérification du domaine, elle, ne l'est pas (voir ci-dessous).
   * 5. *Métrique de réputation* — les rebonds et plaintes de ces envois ne
   *    comptent ni au numérateur ni au dénominateur de `ReputationService` :
   *    un client n'a pas à être suspendu pour un email qu'il n'a pas envoyé,
   *    et l'exclusion serait un cadeau empoisonné si elle ne portait que sur
   *    le numérateur (voir `reputation.service.ts`).
   * 6. *Journal des envois et KPI admin* — ces lignes ne sont pas « ce que ce
   *    client a envoyé » et n'apparaissent donc ni dans `GET /v1/emails` ni
   *    dans `emailsSent30d`.
   *
   * **Ce que l'exemption ne contourne PAS** :
   * - la *liste de suppression* : consultée ici comme pour un envoi client, et
   *   de nouveau par le worker. Une adresse en rebond dur reste inadressable,
   *   y compris pour un email système ;
   * - la *vérification du domaine d'expédition* : le domaine de
   *   `SYSTEM_EMAIL_FROM` doit exister en base avec le statut `VERIFIED`.
   *   Sans quoi l'envoi est refusé ici, avant toute mise en file ;
   * - le *pipeline d'envoi* : file, tentatives, backoff, statuts, traçabilité
   *   dans `Email`, remontée SNS — rien n'est court-circuité ;
   * - la *suspension du compte* n'est pas contournée non plus au sens où elle
   *   n'a jamais porté sur la réception : un compte suspendu ne peut pas
   *   envoyer, il peut recevoir nos messages.
   *
   * @throws {SystemSenderUnavailableError} configuration serveur inutilisable.
   */
  async sendSystem(payload: SystemEmailPayload): Promise<SystemSendResult> {
    const configured = (
      this.configService.get<string>('SYSTEM_EMAIL_FROM') ?? ''
    ).trim();

    if (!configured) {
      throw new SystemSenderUnavailableError(
        'SYSTEM_EMAIL_FROM non renseignée',
      );
    }

    const from = parseEmailAddress(configured);

    if (!from) {
      throw new SystemSenderUnavailableError(
        `SYSTEM_EMAIL_FROM illisible : ${configured}`,
      );
    }

    const toAddress = normalizeEmailAddress(payload.to);

    if (!toAddress) {
      throw new BadRequestException(INVALID_TO_MESSAGE);
    }

    // Non contourné : le domaine d'expédition doit être vérifié. La propriété,
    // elle, ne peut pas l'être — le domaine est celui de Zendou, pas celui du
    // destinataire — d'où la recherche sans `userId`.
    const domain = await this.prisma.domain.findFirst({
      where: { name: from.domain, status: DomainStatus.VERIFIED },
      select: { id: true },
    });

    if (!domain) {
      throw new SystemSenderUnavailableError(
        `domaine ${from.domain} absent ou non vérifié dans Zendou`,
      );
    }

    // Non contourné : la liste de suppression s'applique aussi aux emails
    // système. Rien n'est mis en file, et l'appelant apprend que l'adresse est
    // morte au lieu de faire patienter l'utilisateur indéfiniment.
    if (await isAddressSuppressed(this.prisma, payload.userId, toAddress)) {
      this.logger.warn(
        `Envoi système non expédié : ${toAddress} est sur la liste de suppression`,
      );
      return { status: 'suppressed' };
    }

    // Aucune `CreditEntry` ici, et donc aucune transaction : il n'y a rien à
    // rendre indissociable de la création de la ligne.
    const email = await this.prisma.email.create({
      data: {
        userId: payload.userId,
        domainId: domain.id,
        fromAddress: formatEmailAddress(from),
        toAddress,
        subject: payload.subject,
        publicId: generateEmailPublicId(),
        status: EmailStatus.QUEUED,
        system: true,
      },
      select: { id: true, publicId: true },
    });

    await this.queue.add(
      EMAIL_SEND_JOB,
      { emailId: email.id, html: payload.html, text: payload.text },
      {
        jobId: email.publicId,
        attempts: SEND_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: SEND_JOB_BACKOFF_DELAY_MS },
        removeOnComplete: true,
      },
    );

    return { status: 'queued', id: email.publicId };
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

  /**
   * `true` si `address` (déjà normalisée par `parseEmailAddress`) est celle
   * du mode bac à sable — `TEST_EMAIL_FROM`. Absente ou illisible, ce mode
   * est simplement indisponible : tout envoi retombe sur
   * `requireVerifiedDomain`, sans régression possible.
   */
  private isTestSenderAddress(address: string): boolean {
    const configured = (
      this.configService.get<string>('TEST_EMAIL_FROM') ?? ''
    ).trim();

    if (!configured) {
      return false;
    }

    return parseEmailAddress(configured)?.address === address;
  }

  /**
   * Contrepartie de l'exemption de domaine du mode bac à sable : le seul
   * destinataire autorisé est l'adresse **du compte appelant**
   * (`user.email`), et elle seule.
   *
   * Ce n'est pas une limite arbitraire copiée sur Resend — c'est ce qui
   * protège la réputation du domaine d'expédition partagé. L'adresse du
   * compte est déjà confirmée (`EmailVerifiedGuard`, requis en amont pour
   * atteindre cette méthode) : elle a donc déjà reçu un email avec succès,
   * ce qui rend le risque de rebond dur quasi nul. Sans cette restriction,
   * `TEST_EMAIL_FROM` — un domaine que **Zendou** possède, pas le client —
   * deviendrait un relais d'envoi anonyme vers n'importe quelle adresse : sa
   * réputation s'abîmerait en quelques heures. Et ce domaine est
   * aujourd'hui aussi celui qui expédie les emails de confirmation
   * d'inscription (`SYSTEM_EMAIL_FROM`) : s'il se dégrade, plus aucun
   * nouveau client ne reçoit sa confirmation — la porte d'entrée du produit
   * se ferme. Ce raisonnement doit survivre à toute réécriture de cette
   * méthode.
   *
   * Ne renvoie jamais qu'un `domainId` nul : un envoi de test n'est
   * rattaché à aucun `Domain` du client (il n'en a pas forcément un), et
   * la colonne `Email.domainId` est nullable précisément pour ce cas.
   * `requireVerifiedDomain`, lui, reste inchangé pour tout autre envoi.
   */
  private async requireOwnAddressAsRecipient(
    userId: string,
    toAddress: string,
  ): Promise<null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const ownAddress = user ? normalizeEmailAddress(user.email) : null;

    if (!ownAddress || ownAddress !== toAddress) {
      throw new ForbiddenException(TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE);
    }

    return null;
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
      // `system: false` : le quota du client compte ce que **le client** a
      // envoyé. Un lien de confirmation que Zendou lui expédie ne doit pas
      // lui coûter un envoi de sa journée.
      this.prisma.email.count({
        where: {
          userId,
          system: false,
          queuedAt: { gte: startOfUtcDay(new Date()) },
        },
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

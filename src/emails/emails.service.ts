import { randomBytes } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { DomainStatus, EmailStatus, UserStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { EMAIL_NOT_VERIFIED_MESSAGE } from '../auth/email-confirmation.constants';
import { isEmailConfirmed } from '../auth/email-verified.guard';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import {
  formatEmailAddress,
  normalizeEmailAddress,
  parseEmailAddress,
} from './email-address';
import {
  ACCOUNT_SUSPENDED_MESSAGE,
  BODY_TOO_LARGE_MESSAGE,
  CREDITS_PER_EMAIL,
  CREDIT_REASON_SEND,
  DAILY_LIMIT_REACHED_MESSAGE,
  DOMAIN_NOT_VERIFIED_MESSAGE,
  EMAIL_PUBLIC_ID_BYTES,
  EMAIL_PUBLIC_ID_PREFIX,
  EMAIL_SEND_JOB,
  FAILED_EMAIL_JOB_RETENTION_SECONDS,
  INSUFFICIENT_CREDITS_MESSAGE,
  INVALID_FROM_MESSAGE,
  INVALID_REPLY_TO_MESSAGE,
  INVALID_TO_MESSAGE,
  LOW_BALANCE_FLOOR,
  LOW_BALANCE_RATIO,
  MAX_BODY_BYTES,
  MISSING_BODY_MESSAGE,
  REPLY_TO_NOT_VERIFIED_MESSAGE,
  SEND_JOB_ATTEMPTS,
  SEND_JOB_BACKOFF_DELAY_MS,
  SEND_REFUSAL,
  SEND_REFUSAL_REASON,
  SYSTEM_SENDER_UNAVAILABLE_MESSAGE,
  TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE,
  TEST_SENDER_UNAVAILABLE_MESSAGE,
} from './emails.constants';
import type { SendRefusalReason } from './emails.constants';
import type {
  AcceptEmailInput,
  AcceptSmtpInput,
  EmailSendJobData,
  SendEmailResponse,
  SystemEmailPayload,
  SystemSendResult,
} from './emails.types';
import type { SendEmailDto } from './dto/send-email.dto';
import { recordAccountActivity } from '../account-lifecycle/account-activity';
import { validateCustomHeaders } from './email-headers';
import {
  buildBillingUrl,
  buildLowBalanceAlertEmail,
} from './low-balance-alert.template';
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
   *
   * Simple appelant du point d'acceptation partagé : **aucune règle ne vit
   * ici**. C'est ce qui garantit qu'un second point d'entrée (relais SMTP, B6)
   * subit exactement les mêmes contrôles, sans les dupliquer.
   */
  async send(userId: string, dto: SendEmailDto): Promise<SendEmailResponse> {
    // Propre au canal API : le relais SMTP porte ses en-têtes dans le MIME.
    // Refusé avant tout contrôle de compte, sans effet de bord.
    if (dto.headers !== undefined) {
      const headersError = validateCustomHeaders(dto.headers);

      if (headersError) {
        throw new BadRequestException(headersError);
      }
    }

    return this.accept(userId, {
      from: dto.from,
      to: dto.to,
      subject: dto.subject,
      // L'API n'accepte qu'une adresse de réponse ; `accept()` en prend une
      // liste parce que le relais SMTP peut en présenter plusieurs.
      replyTo: dto.replyTo === undefined ? undefined : [dto.replyTo],
      content: {
        kind: 'simple',
        html: dto.html,
        text: dto.text,
        headers: dto.headers,
      },
      channel: 'API',
    });
  }

  /**
   * Second appelant du point d'acceptation partagé : un destinataire d'un
   * message reçu par le relais SMTP (B6/S7).
   *
   * **Aucune règle ne vit ici non plus.** La méthode ne fait que nommer ce qui
   * distingue ce canal — contenu `raw`, `channel: 'SMTP'`, identifiant SMTP
   * tracé — et délègue la décision à {@link accept}. C'est la garantie
   * structurelle du chantier : il n'existe qu'un seul endroit où un email est
   * accepté, débité et mis en file, et le relais ne peut contourner aucune des
   * protections qui y vivent (suspension T12, adresse confirmée, domaine
   * vérifié et possédé, restriction du bac à sable, liste de suppression,
   * solde, quota journalier).
   *
   * **Un appel = un destinataire = une ligne `Email` = un crédit = un job.**
   * L'éventail multi-destinataires du §4.7 est un appel par destinataire, côté
   * relais : l'équivalent exact de N appels API, aucune règle diluée.
   *
   * Le retour est celui de `accept()` : `suppressed` n'est pas une erreur —
   * une ligne est créée, sans débit ni mise en file, exactement comme sur le
   * canal API (A9).
   */
  async acceptSmtp(
    userId: string,
    input: AcceptSmtpInput,
  ): Promise<SendEmailResponse> {
    return this.accept(userId, {
      from: input.from,
      to: input.to,
      subject: input.subject,
      replyTo: input.replyTo,
      content: { kind: 'raw', raw: input.raw },
      channel: 'SMTP',
      smtpCredentialId: input.smtpCredentialId,
    });
  }

  /**
   * **Contrôles anticipés du relais SMTP, étape `MAIL FROM`** (§4.8).
   *
   * 🔴 Invariant de sécurité, à ne jamais perdre : **les contrôles anticipés ne
   * peuvent que REFUSER, jamais AUTORISER.** Cette méthode ne rend rien, ne
   * pose aucun drapeau, n'écrit rien — son seul effet possible est de lever.
   * La décision qui fait foi reste celle de {@link accept}, exécutée à la fin
   * de `DATA` pour chaque destinataire. Même si cette méthode dérivait, ou
   * qu'un appelant l'oubliait, aucune protection ne serait contournée : elle
   * n'existe que pour refuser **tôt** — avant que le client ne téléverse
   * plusieurs mégaoctets — ce qui serait de toute façon refusé **tard**.
   *
   * Elle ne duplique aucune règle : chacun des contrôles ci-dessous est
   * l'**appel de la méthode privée** qui porte déjà cette règle pour
   * `accept()`. Il n'existe donc qu'une implémentation de chaque règle, et une
   * correction faite pour l'API vaut immédiatement pour le relais.
   *
   * Ce qui n'est **pas** contrôlé ici, et pourquoi :
   * - le destinataire (liste de suppression, restriction du bac à sable) :
   *   inconnu au `MAIL FROM` ;
   * - l'en-tête `From:` du message : inconnu avant `DATA`. C'est lui qui fait
   *   foi (§4.3) — l'enveloppe validée ici ne le remplace pas, elle s'y ajoute.
   */
  async precheckSmtpEnvelope(userId: string, from: string): Promise<void> {
    await this.assertAccountMaySend(userId);

    const parsed = parseEmailAddress(from);

    if (!parsed) {
      throw refuse(
        SEND_REFUSAL.INVALID_FROM,
        HttpStatus.BAD_REQUEST,
        INVALID_FROM_MESSAGE,
        (body) => new BadRequestException(body),
      );
    }

    if (this.isTestSenderAddress(parsed.address)) {
      // Seule la configuration du mode bac à sable est vérifiable ici. La
      // restriction de destinataire qui l'accompagne
      // (`requireOwnAddressAsRecipient`) reste dans `accept()` : elle a besoin
      // du destinataire, et surtout elle doit porter sur l'en-tête `From:`,
      // pas sur l'enveloppe.
      await this.requireVerifiedTestSenderDomain(parsed.domain);
    } else {
      await this.requireVerifiedDomain(userId, parsed.domain);
    }

    await this.assertSufficientCredits(userId);
    await this.assertDailyLimitNotReached(userId);
  }

  /**
   * **Contrôles anticipés du relais SMTP, étape `RCPT TO`** (§4.7) : le solde
   * et le quota journalier couvrent-ils le **total courant** de destinataires ?
   *
   * Même invariant que {@link precheckSmtpEnvelope} : cette méthode ne peut que
   * refuser. Elle évite d'accepter un message qu'on ne pourrait honorer qu'à
   * moitié — mieux vaut un `452 4.5.3` sur le destinataire de trop, que le
   * client peut relivrer, qu'une copie manquante découverte au journal.
   *
   * La course concurrente (deux connexions simultanées qui passent le contrôle
   * avant que l'une ne débite) existe à l'identique sur l'API et n'est ni
   * aggravée ni corrigée ici — hors périmètre B6, §4.7. Sa fenêtre est
   * refermée autant que possible par le fait que la décision qui fait foi
   * reste celle de `accept()`, par destinataire, dans sa transaction.
   *
   * @param recipients Nombre total de destinataires du message, celui en cours
   *   d'examen compris.
   */
  async precheckSmtpRecipients(
    userId: string,
    recipients: number,
  ): Promise<void> {
    await this.assertSufficientCredits(userId, recipients);
    await this.assertDailyLimitNotReached(userId, recipients);
  }

  /**
   * **Point d'acceptation unique** : la seule fonction qui décide qu'un email
   * est accepté, le trace, débite son crédit et le met en file. Une règle
   * d'envoi ajoutée ici vaut pour tous les points d'entrée ; une règle ajoutée
   * ailleurs — dans un garde HTTP, dans un futur handler SMTP — est un
   * contournement en puissance pour tous les autres.
   *
   * Ordre des contrôles, inchangé depuis la version couplée à HTTP hormis les
   * deux premiers, qui viennent d'y être rapatriés :
   * 1. compte non suspendu, adresse du compte confirmée
   *    (`assertAccountMaySend`) ;
   * 2. `from` analysable, `to` normalisable ;
   * 3. corps présent et sous la limite — contenu `simple` uniquement ;
   * 4. mode bac à sable **ou** domaine vérifié et possédé ;
   * 5. liste de suppression → ligne `SUPPRESSED`, sans débit ni mise en file ;
   * 6. solde de crédits, puis quota journalier ;
   * 7. transaction `Email` + `CreditEntry`, puis mise en file avec
   *    `jobId = publicId`.
   *
   * Les refus restent des `HttpException` — le contrat de `POST /v1/emails` ne
   * bouge pas — mais portent en plus un motif symbolique (`SEND_REFUSAL`),
   * lisible par `sendRefusalReason`, pour qu'un appelant non-HTTP déduise sa
   * propre réponse du motif plutôt que d'un statut ou d'un message français.
   */
  private async accept(
    userId: string,
    input: AcceptEmailInput,
  ): Promise<SendEmailResponse> {
    const { lastActivityAt, lowBalanceAlertSentAt } =
      await this.assertAccountMaySend(userId);

    const from = parseEmailAddress(input.from);

    if (!from) {
      throw refuse(
        SEND_REFUSAL.INVALID_FROM,
        HttpStatus.BAD_REQUEST,
        INVALID_FROM_MESSAGE,
        (body) => new BadRequestException(body),
      );
    }

    // Un seul destinataire en v1, sous les deux formes du `From:` (adresse nue
    // ou « Nom <adresse> »). L'adresse nue en minuscules reste la clé partout
    // (suppression, bac à sable, ligne `Email`) ; le nom d'affichage ne sert
    // qu'à la remise à SES (`toDisplay`).
    const to = parseEmailAddress(input.to);
    const toAddress = to?.address;

    if (!to || !toAddress) {
      throw refuse(
        SEND_REFUSAL.INVALID_TO,
        HttpStatus.BAD_REQUEST,
        INVALID_TO_MESSAGE,
        (body) => new BadRequestException(body),
      );
    }

    // Présence et taille du corps ne concernent que le contenu simple :
    // `MAX_BODY_BYTES` est une limite **par corps**, mesurée sur des chaînes,
    // et ne peut pas servir de plafond à un message MIME entier (une pièce
    // jointe la dépasserait à elle seule). Le plafond du contenu `raw` est le
    // périmètre de B6/S3.
    const html =
      input.content.kind === 'simple'
        ? blankToUndefined(input.content.html)
        : undefined;
    const text =
      input.content.kind === 'simple'
        ? blankToUndefined(input.content.text)
        : undefined;

    if (input.content.kind === 'simple') {
      if (!html && !text) {
        throw refuse(
          SEND_REFUSAL.MISSING_BODY,
          HttpStatus.BAD_REQUEST,
          MISSING_BODY_MESSAGE,
          (body) => new BadRequestException(body),
        );
      }

      if (exceedsMaxBody(html) || exceedsMaxBody(text)) {
        throw refuse(
          SEND_REFUSAL.BODY_TOO_LARGE,
          HttpStatus.BAD_REQUEST,
          BODY_TOO_LARGE_MESSAGE,
          (body) => new BadRequestException(body),
        );
      }
    }

    // Mode bac à sable (B20) : reconnu au seul rapprochement d'adresse, sans
    // se soucier du nom d'affichage — un client peut envoyer
    // « Ma Boutique <adresse-de-test> » et rester dans ce mode.
    //
    // Le domaine de `TEST_EMAIL_FROM` est vérifié en premier, avant même la
    // restriction de destinataire : c'est une erreur de configuration
    // Zendou, indépendante de ce que le client a demandé. Même exigence que
    // `sendSystem` pour `SYSTEM_EMAIL_FROM` — même type d'adresse (une
    // adresse qui appartient à Zendou, pas au client) —, pour ne pas
    // reproduire la divergence qui a déjà causé un bug sur ce projet (V6-D).
    let domainId: string | null;

    if (this.isTestSenderAddress(from.address)) {
      await this.requireVerifiedTestSenderDomain(from.domain);
      domainId = await this.requireOwnAddressAsRecipient(userId, toAddress);
    } else {
      domainId = await this.requireVerifiedDomain(userId, from.domain);
    }

    // Adresse(s) de réponse : **exactement la règle du `From:`**, y compris en
    // mode bac à sable - un client sans domaine vérifié ne peut pas poser de
    // reply-to. Sans cela, l'usurpation d'expéditeur reste ouverte par la
    // bande : on expédie depuis un domaine qu'on possède, et la conversation
    // atterrit chez un tiers, sous la signature DKIM de Zendou.
    //
    // Placé ici, avant la liste de suppression et avant tout débit : un refus
    // ne laisse ni ligne `Email`, ni `CreditEntry`, ni job.
    const replyTo = await this.requireVerifiedReplyTo(userId, input.replyTo);

    const fromAddress = formatEmailAddress(from);
    const common = {
      userId,
      domainId,
      fromAddress,
      toAddress,
      subject: input.subject,
      // Traçabilité du canal d'entrée (§6, A15) : `channel` dit par où l'envoi
      // est arrivé, `smtpCredentialId` **quel identifiant** l'a expédié quand
      // c'est le relais. Écrits dans la transaction existante, sans logique
      // nouvelle : les deux valeurs viennent de l'appelant, aucune décision
      // n'est prise ici. `null` — et non `undefined` — pour le canal API : la
      // colonne est explicitement vidée plutôt que laissée au hasard d'un
      // champ absent.
      channel: input.channel,
      smtpCredentialId: input.smtpCredentialId ?? null,
      //
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

      this.recordActivity(userId, lastActivityAt);

      return { id: suppressed.publicId, status: 'suppressed' };
    }

    const balanceBefore = await this.assertSufficientCredits(userId);
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
    //
    // Le corps voyage dans le job — le modèle `Email` n'en stocke aucun. Le
    // contenu `simple` garde **exactement** la charge utile d'avant
    // l'introduction du canal Raw : pas de `kind` ajouté. C'est délibéré et
    // symétrique du repli du worker (« `kind` absent ⇒ `simple` », B6/S3) :
    // les jobs d'hier, d'aujourd'hui et de demain ont la même forme sur le
    // canal API, donc rien à migrer et rien à perdre au redéploiement.
    await this.queue.add(
      EMAIL_SEND_JOB,
      input.content.kind === 'raw'
        ? {
            emailId: email.id,
            kind: 'raw',
            raw: toRawString(input.content.raw),
          }
        : {
            emailId: email.id,
            html,
            text,
            // Ajouté seulement s'il y en a une : la charge utile d'un envoi
            // sans reply-to reste **exactement** celle d'avant, comme pour
            // `kind` (rien à migrer au redéploiement).
            ...(replyTo.length > 0 ? { replyTo: replyTo[0] } : {}),
            // Nom d'affichage du destinataire : seulement s'il y en a un.
            ...(to.name ? { toDisplay: formatEmailAddress(to) } : {}),
            // Même principe : le job d'un envoi sans en-têtes reste identique.
            ...(input.content.headers &&
            Object.keys(input.content.headers).length > 0
              ? { headers: input.content.headers }
              : {}),
          },
      {
        // L'identifiant public sert de clé d'idempotence côté file.
        jobId: email.publicId,
        attempts: SEND_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: SEND_JOB_BACKOFF_DELAY_MS },
        removeOnComplete: true,
        // Politique de confidentialité (25/09) : un job en échec définitif ne
        // garde son corps dans Redis que 7 jours. Voir
        // `FAILED_EMAIL_JOB_RETENTION_SECONDS` pour ce que ce champ couvre et
        // ne couvre pas.
        removeOnFail: { age: FAILED_EMAIL_JOB_RETENTION_SECONDS },
      },
    );

    this.recordActivity(userId, lastActivityAt);
    this.alertIfLowBalance(
      userId,
      balanceBefore - CREDITS_PER_EMAIL,
      lowBalanceAlertSentAt,
    );

    return { id: email.publicId, status: 'queued' };
  }

  /**
   * Alerte de solde bas, hors du chemin critique : un envoi déjà accepté ne
   * doit jamais échouer ni attendre à cause d'elle. Tout échec est journalisé.
   *
   * Appelée après chaque débit d'envoi du point d'acceptation, donc aussi bien
   * pour l'API que pour le relais SMTP. `sendSystem` ne débite pas et n'y
   * passe jamais : l'alerte ne peut pas se déclencher elle-même.
   *
   * `estimatedBalance` (solde lu par `assertSufficientCredits`, moins le crédit
   * débité) et `alertSentAt` (lu avec le compte) évitent toute relecture du
   * grand livre sur le chemin courant.
   */
  private alertIfLowBalance(
    userId: string,
    estimatedBalance: number,
    alertSentAt: Date | null,
  ): void {
    void this.sendLowBalanceAlert(userId, estimatedBalance, alertSentAt).catch(
      (error: unknown) => {
        this.logger.warn(
          `Alerte de solde bas en échec pour l'utilisateur ${userId}`,
          error instanceof Error ? error.stack : String(error),
        );
      },
    );
  }

  /**
   * Seuil : `LOW_BALANCE_RATIO` du solde atteint juste après le dernier crédit
   * positif, plancher `LOW_BALANCE_FLOOR`. Une alerte par passage : le
   * marqueur `lowBalanceAlertSentAt` la tient jusqu'à ce qu'un crédit positif
   * plus récent la périme, ce qui réarme le mécanisme sans état à remettre à
   * zéro. La prise du marqueur est atomique (deux envois concurrents ne
   * produisent qu'un message).
   *
   * Coût par envoi, du moins au plus cher, avec sortie dès que l'alerte est
   * exclue : une lecture du dernier crédit ; puis, si le compte n'est pas déjà
   * alerté depuis ce crédit, une somme du grand livre jusqu'à ce crédit. Le
   * solde courant et le marqueur sont déjà connus. Le solde exact, le compte
   * et la prise du marqueur ne sont lus que dans le cas rare où le solde est
   * réellement sous le seuil. Aucune borne constante ne garantit l'absence
   * d'alerte (le seuil dépend du solde après le dernier crédit), d'où la
   * lecture du dernier crédit.
   */
  private async sendLowBalanceAlert(
    userId: string,
    estimatedBalance: number,
    alertSentAt: Date | null,
  ): Promise<void> {
    const lastCredit = await this.prisma.creditEntry.findFirst({
      where: { userId, delta: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (!lastCredit || (alertSentAt && alertSentAt >= lastCredit.createdAt)) {
      return;
    }

    const afterCredit = await this.prisma.creditEntry.aggregate({
      where: { userId, createdAt: { lte: lastCredit.createdAt } },
      _sum: { delta: true },
    });
    const threshold = Math.max(
      LOW_BALANCE_FLOOR,
      (afterCredit._sum.delta ?? 0) * LOW_BALANCE_RATIO,
    );

    if (estimatedBalance >= threshold) {
      return;
    }

    // Cas rare : le solde exact (des envois concurrents ont pu passer).
    const current = await this.prisma.creditEntry.aggregate({
      where: { userId },
      _sum: { delta: true },
    });
    const balance = current._sum.delta ?? 0;

    if (balance >= threshold) {
      return;
    }

    const claimed = await this.prisma.user.updateMany({
      where: {
        id: userId,
        OR: [
          { lowBalanceAlertSentAt: null },
          { lowBalanceAlertSentAt: { lt: lastCredit.createdAt } },
        ],
      },
      data: { lowBalanceAlertSentAt: new Date() },
    });

    if (claimed.count === 0) {
      return;
    }

    try {
      const account = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true },
      });

      if (!account) {
        return;
      }

      const message = buildLowBalanceAlertEmail({
        name: account.name,
        balance,
        billingUrl: buildBillingUrl(this.appBaseUrl()),
      });

      await this.sendSystem({
        userId,
        to: account.email,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    } catch (error) {
      // Envoi impossible : le marqueur est levé, le prochain débit retentera.
      await this.prisma.user.updateMany({
        where: { id: userId },
        data: { lowBalanceAlertSentAt: alertSentAt },
      });

      throw error;
    }
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

  /**
   * Un envoi client accepté est une activité (ANON-1). Aucune requête si
   * l'activité connue a moins d'une heure ; sinon une écriture, hors du
   * chemin critique : l'envoi est déjà accepté, rien ne doit le remettre en
   * cause.
   */
  private recordActivity(userId: string, known: Date | null): void {
    void recordAccountActivity(this.prisma, userId, new Date(), known).catch(
      (error: unknown) => {
        this.logger.warn(
          `Enregistrement de l'activité en échec pour l'utilisateur ${userId}`,
          error instanceof Error ? error.stack : String(error),
        );
      },
    );
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
        // Même politique que l'envoi client (voir plus haut) : même file,
        // même worker, même promesse de purge à 7 jours.
        removeOnFail: { age: FAILED_EMAIL_JOB_RETENTION_SECONDS },
      },
    );

    return { status: 'queued', id: email.publicId };
  }

  /**
   * État du compte : deux règles qui, jusqu'ici, ne vivaient que dans des
   * gardes HTTP — `ApiKeyAuthGuard` pour la suspension, `EmailVerifiedGuard`
   * pour la confirmation d'adresse.
   *
   * Un garde ne protège qu'une route. Tant que ces deux règles vivaient là,
   * tout appelant du service qui ne passait pas par Express — un relais SMTP,
   * une tâche planifiée, un script d'exploitation — laissait envoyer un compte
   * suspendu par T12 ou un compte jamais confirmé. Les gardes restent en
   * place, ils donnent le bon statut au bon moment ; le contrôle qui **fait
   * foi** est celui-ci.
   *
   * Rien ne change pour l'API : les gardes refusent déjà plus tôt, en 403, et
   * ce contrôle ne peut donc jamais s'y déclencher.
   */
  private async assertAccountMaySend(userId: string): Promise<{
    lastActivityAt: Date | null;
    lowBalanceAlertSentAt: Date | null;
  }> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        emailVerifiedAt: true,
        lastActivityAt: true,
        lowBalanceAlertSentAt: true,
      },
    });

    if (account?.status === UserStatus.SUSPENDED) {
      throw refuse(
        SEND_REFUSAL.ACCOUNT_SUSPENDED,
        HttpStatus.FORBIDDEN,
        ACCOUNT_SUSPENDED_MESSAGE,
        (body) => new ForbiddenException(body),
      );
    }

    // `account.emailVerifiedAt` est la colonne elle-même : `null` tant que
    // l'adresse n'est pas confirmée. Rien à normaliser ici, contrairement au
    // garde HTTP qui lit un `request.user` assemblé en amont, potentiellement
    // partiel — c'est lui qui referme sur l'absence, pas le prédicat.
    //
    // Un `userId` sans ligne `User` n'est pas traité comme un refus : ce cas
    // ne peut pas venir d'un appelant authentifié, et la contrainte de clé
    // étrangère de `Email.userId` l'arrête déjà — comportement inchangé.
    if (account && !isEmailConfirmed(account.emailVerifiedAt)) {
      throw refuse(
        SEND_REFUSAL.EMAIL_NOT_VERIFIED,
        HttpStatus.FORBIDDEN,
        EMAIL_NOT_VERIFIED_MESSAGE,
        (body) => new ForbiddenException(body),
      );
    }

    return {
      lastActivityAt: account?.lastActivityAt ?? null,
      lowBalanceAlertSentAt: account?.lowBalanceAlertSentAt ?? null,
    };
  }

  /**
   * Vérifie que le domaine appartient au client et qu'il est vérifié. Un
   * domaine appartenant à un tiers donne la même réponse qu'un domaine
   * inconnu : pas d'oracle sur les domaines des autres.
   *
   * L'égalité du nom est **stricte** : `mail.exemple.gn` n'est pas
   * `exemple.gn`. Un sous-domaine est un domaine à part entière, qu'il faut
   * ajouter et vérifier séparément - sans quoi vérifier `exemple.gn`
   * ouvrirait l'expédition depuis n'importe quel sous-domaine, y compris ceux
   * que le client ne contrôle pas (hébergement mutualisé, sous-domaine
   * délégué).
   *
   * Deux appelants, deux refus : l'expéditeur (`from`, motif par défaut) et
   * l'adresse de réponse (`replyTo`, motif passé par
   * {@link requireVerifiedReplyTo}). La **règle** est la même - une seule
   * requête, un seul filtre - seul le motif rendu au client change, pour qu'il
   * sache laquelle des deux adresses corriger.
   */
  private async requireVerifiedDomain(
    userId: string,
    name: string,
    refusal: {
      reason: SendRefusalReason;
      message: string;
    } = {
      reason: SEND_REFUSAL.DOMAIN_NOT_VERIFIED,
      message: DOMAIN_NOT_VERIFIED_MESSAGE,
    },
  ): Promise<string> {
    const domain = await this.prisma.domain.findFirst({
      where: { name, userId, status: DomainStatus.VERIFIED },
      select: { id: true },
    });

    if (!domain) {
      throw refuse(
        refusal.reason,
        HttpStatus.FORBIDDEN,
        refusal.message,
        (body) => new ForbiddenException(body),
      );
    }

    return domain.id;
  }

  /**
   * Valide les adresses de réponse demandées et rend leur forme normalisée.
   *
   * Deux contrôles par adresse, dans l'ordre, et **la première qui échoue
   * refuse tout l'envoi** - on ne réécrit ni ne retire aucun en-tête, on
   * refuse : corriger le message d'un client à sa place, c'est lui livrer
   * autre chose que ce qu'il a écrit.
   *
   * 1. analysable par le validateur maison (le même que pour `from`), sinon
   *    400 `INVALID_REPLY_TO` ;
   * 2. domaine vérifié **et rattaché au compte**, sinon 403
   *    `REPLY_TO_NOT_VERIFIED` - la requête est celle de
   *    {@link requireVerifiedDomain}, motif et message en propre : le client
   *    doit savoir laquelle des deux adresses pose problème.
   *
   * La règle vaut aussi en mode bac à sable : `TEST_EMAIL_FROM` exempte du
   * domaine vérifié **l'expéditeur**, en échange d'une restriction stricte du
   * destinataire. Étendre l'exemption au reply-to rendrait cette contrepartie
   * inopérante - le client s'écrirait à lui-même, mais toute réponse partirait
   * vers l'adresse de son choix, sur un domaine qui n'est pas le sien.
   */
  private async requireVerifiedReplyTo(
    userId: string,
    requested: string[] | undefined,
  ): Promise<string[]> {
    const normalized: string[] = [];

    for (const raw of requested ?? []) {
      const parsed = parseEmailAddress(raw);

      if (!parsed) {
        throw refuse(
          SEND_REFUSAL.INVALID_REPLY_TO,
          HttpStatus.BAD_REQUEST,
          INVALID_REPLY_TO_MESSAGE,
          (body) => new BadRequestException(body),
        );
      }

      await this.requireVerifiedDomain(userId, parsed.domain, {
        reason: SEND_REFUSAL.REPLY_TO_NOT_VERIFIED,
        message: REPLY_TO_NOT_VERIFIED_MESSAGE,
      });

      normalized.push(formatEmailAddress(parsed));
    }

    return normalized;
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
   * Gardes-fou de configuration du mode bac à sable : le domaine de
   * `TEST_EMAIL_FROM` doit exister en base avec le statut `VERIFIED`, tout
   * comme `sendSystem` l'exige pour `SYSTEM_EMAIL_FROM` (voir la recherche
   * sans `userId` autour de la ligne 257) — même besoin, sur le même type
   * d'adresse : une adresse qui appartient à Zendou, pas au client.
   *
   * Sans ce contrôle, une mauvaise configuration (domaine absent ou encore
   * `PENDING`) ne serait détectée qu'au moment de l'envoi SES — après que le
   * client ait déjà été débité d'un crédit pour un email qui ne partira
   * jamais. Le contrôle doit donc se faire ici, à l'acceptation, avant tout
   * effet de bord.
   *
   * Recherche sans `userId` : comme pour `SYSTEM_EMAIL_FROM`, ce domaine
   * appartient à Zendou, pas au client — il n'y a pas de propriété à
   * vérifier, seulement le statut.
   *
   * @throws {ServiceUnavailableException} domaine absent ou non `VERIFIED`.
   */
  private async requireVerifiedTestSenderDomain(name: string): Promise<void> {
    const domain = await this.prisma.domain.findFirst({
      where: { name, status: DomainStatus.VERIFIED },
      select: { id: true },
    });

    if (!domain) {
      this.logger.error(
        `Mode bac à sable indisponible : domaine ${name} (TEST_EMAIL_FROM) absent ou non VERIFIED dans Zendou`,
      );
      throw refuse(
        SEND_REFUSAL.TEST_SENDER_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
        TEST_SENDER_UNAVAILABLE_MESSAGE,
        (body) => new ServiceUnavailableException(body),
      );
    }
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
      throw refuse(
        SEND_REFUSAL.TEST_SENDER_RECIPIENT_RESTRICTED,
        HttpStatus.FORBIDDEN,
        TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE,
        (body) => new ForbiddenException(body),
      );
    }

    return null;
  }

  /**
   * Le solde est la somme des mouvements de crédits du client.
   *
   * @param messages Nombre d'envois à couvrir. Vaut 1 partout où un seul email
   *   est en jeu — c'est-à-dire sur tout le chemin d'`accept()`, canal API
   *   comme canal SMTP, puisque chaque destinataire y est un envoi distinct.
   *   Seul le contrôle anticipé du `RCPT TO` (§4.7) passe davantage : il
   *   demande si le solde couvre **le total courant** du message en cours, pour
   *   refuser le destinataire de trop plutôt qu'un demi-message.
   */
  private async assertSufficientCredits(
    userId: string,
    messages = 1,
  ): Promise<number> {
    const { _sum } = await this.prisma.creditEntry.aggregate({
      where: { userId },
      _sum: { delta: true },
    });
    const balance = _sum.delta ?? 0;

    if (balance < CREDITS_PER_EMAIL * messages) {
      throw refuse(
        SEND_REFUSAL.INSUFFICIENT_CREDITS,
        HttpStatus.PAYMENT_REQUIRED,
        INSUFFICIENT_CREDITS_MESSAGE,
        (body) => new HttpException(body, HttpStatus.PAYMENT_REQUIRED),
      );
    }

    return balance;
  }

  /**
   * Quota journalier, compté sur les emails créés depuis minuit UTC.
   *
   * @param messages Nombre d'envois à loger dans le quota restant. Même
   *   raisonnement que pour {@link assertSufficientCredits} : 1 partout, sauf
   *   au contrôle anticipé du `RCPT TO`, qui demande si le quota couvre le
   *   total courant du message.
   */
  private async assertDailyLimitNotReached(
    userId: string,
    messages = 1,
  ): Promise<void> {
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

    if (user && today + messages > user.dailySendLimit) {
      throw refuse(
        SEND_REFUSAL.DAILY_LIMIT_REACHED,
        HttpStatus.TOO_MANY_REQUESTS,
        DAILY_LIMIT_REACHED_MESSAGE,
        (body) => new HttpException(body, HttpStatus.TOO_MANY_REQUESTS),
        // Le seul refus dont l'attente est **connue** : le quota se remet à
        // zéro au prochain début de journée de la fenêtre de comptage (minuit
        // UTC, voir `startOfUtcDay` - c'est ce même repère que compte
        // `email.count` ci-dessus, les deux ne doivent jamais diverger). Le
        // filtre global en fait l'en-tête `Retry-After`, pour que le client
        // patiente au lieu de marteler.
        { retryAfter: secondsUntilNextUtcDay(new Date()) },
      );
    }
  }
}

/** Exception d'acceptation vue sous l'angle du motif qu'elle transporte. */
interface SendRefusalCarrier {
  [SEND_REFUSAL_REASON]?: SendRefusalReason;
}

/**
 * Corps HTTP d'un refus du point d'acceptation.
 *
 * `code` est le motif `SEND_REFUSAL` lui-même : c'est le discriminant **stable**
 * qu'un client de l'API doit lire. Quatre motifs partagent le 403 et le message
 * français peut être reformulé à tout moment ; le code, lui, ne bouge pas.
 *
 * `statusCode`, `error` et `message` reprennent exactement les trois champs que
 * Nest écrivait déjà pour ces exceptions : le corps ne perd rien, il gagne une
 * clé.
 */
export interface SendRefusalBody extends Record<string, unknown> {
  statusCode: number;
  /** Libellé standard du statut (« Forbidden », « Too Many Requests »…). */
  error: string;
  message: string;
  code: SendRefusalReason;
}

/**
 * Construit une exception de refus : corps normalisé porteur du `code`, et
 * motif symbolique posé sur l'exception.
 *
 * La **classe**, le **statut** et le **message** restent ceux d'avant - le
 * contrat de `POST /v1/emails` ne bouge pas, `instanceof ForbiddenException`
 * tient toujours, et `error.message` rend la même phrase (Nest reprend le champ
 * `message` d'un corps objet). Ce qui s'ajoute :
 *
 * - `code` dans le corps HTTP, recopié tel quel par le filtre global
 *   (`AllExceptionsFilter`, qui repart d'une copie du corps d'origine) ;
 * - `extra`, pour ce qu'un refus particulier sait en plus - aujourd'hui le
 *   `retryAfter` du quota journalier, dont le filtre fait un en-tête ;
 * - le motif en propriété **non énumérable** sous une clé symbole, invisible
 *   d'une sérialisation ou d'une comparaison structurelle, que lit le relais
 *   SMTP (`sendRefusalReason` → `smtpReplyForError`).
 *
 * L'exception est construite par `build` plutôt qu'ici : c'est ce qui garde le
 * choix de la classe au point de refus, là où il se lit.
 */
function refuse<E extends HttpException>(
  reason: SendRefusalReason,
  status: HttpStatus,
  message: string,
  build: (body: SendRefusalBody) => E,
  extra?: Record<string, unknown>,
): E {
  const exception = build({
    statusCode: status,
    error: STATUS_CODES[status] ?? INTERNAL_ERROR_LABEL,
    message,
    code: reason,
    ...extra,
  });

  Object.defineProperty(exception, SEND_REFUSAL_REASON, {
    value: reason,
    enumerable: false,
  });

  return exception;
}

/**
 * Repli du libellé de statut : `http.STATUS_CODES` est le registre IANA tel que
 * Node le livre, et couvre tous les statuts utilisés ici. La branche n'existe
 * que pour le typage.
 */
const INTERNAL_ERROR_LABEL = 'Error';

/**
 * Motif de refus porté par une exception du point d'acceptation, `null` si
 * l'erreur ne vient pas de là (panne base, Redis, bug).
 *
 * C'est le seul discriminant que doit lire un appelant non-HTTP : un statut ne
 * suffit pas — quatre motifs partagent le 403 — et un message français encore
 * moins. Voir `SEND_REFUSAL` (`emails.constants.ts`).
 */
export function sendRefusalReason(error: unknown): SendRefusalReason | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  return (error as SendRefusalCarrier)[SEND_REFUSAL_REASON] ?? null;
}

/** Identifiant public d'un email : `e_` suivi de 12 caractères hex. */
export function generateEmailPublicId(): string {
  return `${EMAIL_PUBLIC_ID_PREFIX}${randomBytes(EMAIL_PUBLIC_ID_BYTES).toString('hex')}`;
}

/** Durée d'une journée, en millisecondes. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Secondes restant jusqu'au **prochain début de journée de la fenêtre du quota
 * journalier**, c'est-à-dire le prochain minuit UTC : le quota compte les
 * emails créés depuis `startOfUtcDay` (voir `assertDailyLimitNotReached`), donc
 * c'est à ce repère-là, et à aucun autre, qu'il se libère.
 *
 * Arrondi **au plafond** et jamais inférieur à 1 : un `Retry-After: 0` invite à
 * réessayer immédiatement, sur un quota qui n'est pas encore remis à zéro.
 */
export function secondsUntilNextUtcDay(reference: Date): number {
  const nextDay = startOfUtcDay(reference).getTime() + DAY_MS;

  return Math.max(1, Math.ceil((nextDay - reference.getTime()) / 1000));
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

/**
 * Octets MIME sous la forme que la charge utile BullMQ sait porter.
 *
 * La file sérialise en JSON : un `Buffer` n'y survivrait pas — il ressortirait
 * du job en `{ type: 'Buffer', data: [...] }`, et le driver enverrait à SES un
 * message qui n'en est pas un. Le relais ne fournit déjà qu'une chaîne
 * (`AcceptSmtpInput.raw`), après un contrôle d'aller-retour qui lui permet de
 * refuser proprement un contenu non convertible ; cette conversion ne couvre
 * donc que le cas d'un appelant interne futur qui passerait des octets.
 */
function toRawString(raw: Buffer | string): string {
  return typeof raw === 'string' ? raw : raw.toString('utf8');
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

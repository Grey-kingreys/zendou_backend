import { randomBytes } from 'node:crypto';
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
  INSUFFICIENT_CREDITS_MESSAGE,
  INVALID_FROM_MESSAGE,
  INVALID_TO_MESSAGE,
  MAX_BODY_BYTES,
  MISSING_BODY_MESSAGE,
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
    return this.accept(userId, {
      from: dto.from,
      to: dto.to,
      subject: dto.subject,
      content: { kind: 'simple', html: dto.html, text: dto.text },
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
        new BadRequestException(INVALID_FROM_MESSAGE),
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
    await this.assertAccountMaySend(userId);

    const from = parseEmailAddress(input.from);

    if (!from) {
      throw refuse(
        SEND_REFUSAL.INVALID_FROM,
        new BadRequestException(INVALID_FROM_MESSAGE),
      );
    }

    // Un seul destinataire en v1, et sous forme d'adresse nue.
    const toAddress = normalizeEmailAddress(input.to);

    if (!toAddress) {
      throw refuse(
        SEND_REFUSAL.INVALID_TO,
        new BadRequestException(INVALID_TO_MESSAGE),
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
          new BadRequestException(MISSING_BODY_MESSAGE),
        );
      }

      if (exceedsMaxBody(html) || exceedsMaxBody(text)) {
        throw refuse(
          SEND_REFUSAL.BODY_TOO_LARGE,
          new BadRequestException(BODY_TOO_LARGE_MESSAGE),
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
        : { emailId: email.id, html, text },
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
  private async assertAccountMaySend(userId: string): Promise<void> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, emailVerifiedAt: true },
    });

    if (account?.status === UserStatus.SUSPENDED) {
      throw refuse(
        SEND_REFUSAL.ACCOUNT_SUSPENDED,
        new ForbiddenException(ACCOUNT_SUSPENDED_MESSAGE),
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
        new ForbiddenException(EMAIL_NOT_VERIFIED_MESSAGE),
      );
    }
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
      throw refuse(
        SEND_REFUSAL.DOMAIN_NOT_VERIFIED,
        new ForbiddenException(DOMAIN_NOT_VERIFIED_MESSAGE),
      );
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
        new ServiceUnavailableException(TEST_SENDER_UNAVAILABLE_MESSAGE),
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
        new ForbiddenException(TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE),
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
  ): Promise<void> {
    const { _sum } = await this.prisma.creditEntry.aggregate({
      where: { userId },
      _sum: { delta: true },
    });

    if ((_sum.delta ?? 0) < CREDITS_PER_EMAIL * messages) {
      throw refuse(
        SEND_REFUSAL.INSUFFICIENT_CREDITS,
        new HttpException(
          INSUFFICIENT_CREDITS_MESSAGE,
          HttpStatus.PAYMENT_REQUIRED,
        ),
      );
    }
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
        new HttpException(
          DAILY_LIMIT_REACHED_MESSAGE,
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
    }
  }
}

/** Exception d'acceptation vue sous l'angle du motif qu'elle transporte. */
interface SendRefusalCarrier {
  [SEND_REFUSAL_REASON]?: SendRefusalReason;
}

/**
 * Marque une exception de refus avec son motif, et la renvoie pour être levée.
 *
 * L'exception elle-même est celle d'avant — même classe, même statut, même
 * message : le contrat HTTP est intact, `instanceof ForbiddenException` tient
 * toujours. Le motif est posé en propriété non énumérable sous une clé
 * symbole, donc invisible d'une sérialisation ou d'une comparaison
 * structurelle.
 */
function refuse<E extends HttpException>(
  reason: SendRefusalReason,
  exception: E,
): E {
  Object.defineProperty(exception, SEND_REFUSAL_REASON, {
    value: reason,
    enumerable: false,
  });

  return exception;
}

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

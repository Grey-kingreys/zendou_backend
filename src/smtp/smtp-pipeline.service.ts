import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  SMTPServerAddress,
  SMTPServerDataStream,
  SMTPServerSession,
} from 'smtp-server';
import {
  formatEmailAddress,
  normalizeEmailAddress,
} from '../emails/email-address';
import {
  MAX_RAW_MESSAGE_BYTES,
  SUBJECT_MAX_LENGTH,
} from '../emails/emails.constants';
import { EmailsService, sendRefusalReason } from '../emails/emails.service';
import { analyzeRawMessage } from './mime-headers';
import {
  SMTP_REPLY_RAW_NOT_UTF8,
  SUBJECT_ABSENT_LABEL,
  formatSmtpAcceptedReply,
  type SmtpRecipientOutcome,
} from './smtp-pipeline.constants';
import { SMTP_DEFAULT_MAX_RECIPIENTS } from './smtp-relay.constants';
import {
  SMTP_REPLY_MIME_INVALID,
  SMTP_REPLY_RCPT_TO_UNREADABLE,
  SMTP_REPLY_SIZE_EXCEEDED,
  SMTP_REPLY_TOO_MANY_RECIPIENTS,
  smtpReplyForError,
} from './smtp-reply';
import { isSmtpReplyError, smtpReplyToError } from './smtp-reply.adapter';
import type { SmtpSessionUser } from './smtp-session';
import { SmtpThrottleService } from './smtp-throttle.service';

/**
 * Pipeline du relais SMTP : `MAIL FROM` → `RCPT TO` → `DATA` → point
 * d'acceptation partagé (B6/S7 — §4 du plan).
 *
 * ## 🔴 L'invariant du §4.8, qui gouverne tout ce fichier
 *
 * **Les contrôles anticipés (`MAIL FROM`, `RCPT TO`) ne peuvent que REFUSER,
 * jamais AUTORISER.** La décision qui fait foi est celle de
 * `EmailsService.accept()`, exécutée à la fin de `DATA`, une fois par
 * destinataire. Concrètement, dans ce fichier :
 *
 * - aucune méthode de contrôle anticipé ne rend de valeur, ne pose de drapeau
 *   sur la session, ni n'écrit quoi que ce soit ; leur seul effet possible est
 *   de lever ;
 * - la fin de `DATA` ne consulte **rien** de ce qu'ils auraient pu constater :
 *   elle appelle `acceptSmtp()`, qui refait la totalité des contrôles.
 *
 * Conséquence, et c'est là tout l'intérêt : même si un contrôle anticipé
 * dérivait — bug, refactor, mock de test — **aucune protection ne pourrait
 * être contournée**. Les contrôles anticipés n'existent que pour refuser
 * **tôt** ce qui serait de toute façon refusé **tard**, et éviter au client de
 * téléverser plusieurs mégaoctets pour rien. Un test dédié le prouve en
 * neutralisant délibérément un contrôle anticipé.
 *
 * ## Aucune règle métier n'est écrite ici
 *
 * Ce service ne connaît ni les crédits, ni le quota, ni les domaines vérifiés,
 * ni la liste de suppression. Il traduit une conversation SMTP en appels au
 * point d'acceptation, et des refus en codes de réponse — rien d'autre. Les
 * seules décisions qui lui appartiennent sont celles que seul le protocole
 * pose : plafond de taille du flux, plafond de destinataires, forme des
 * octets reçus, et texte de la réponse finale.
 */
@Injectable()
export class SmtpPipelineService {
  private readonly logger = new Logger(SmtpPipelineService.name);

  constructor(
    private readonly emailsService: EmailsService,
    private readonly configService: ConfigService,
    private readonly smtpThrottleService: SmtpThrottleService,
  ) {}

  /**
   * Taille maximale d'un message, en octets (§4.5).
   *
   * Source unique : `SmtpServerService` la passe telle quelle à l'option `size`
   * de `smtp-server`, qui l'**annonce** dans l'EHLO (capacité `SIZE`, RFC 1870)
   * et l'applique pendant le flux. Deux lectures indépendantes de la même
   * variable finiraient par diverger, et un plafond annoncé différent du
   * plafond appliqué est le plus mauvais des deux mondes.
   */
  get maxMessageBytes(): number {
    return this.setting('SMTP_MAX_MESSAGE_BYTES', MAX_RAW_MESSAGE_BYTES);
  }

  /** Destinataires acceptés pour un même message (§4.7, A14). */
  get maxRecipients(): number {
    return this.setting('SMTP_MAX_RECIPIENTS', SMTP_DEFAULT_MAX_RECIPIENTS);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIL FROM — contrôle anticipé (ne peut que refuser)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Contrôles anticipés de l'enveloppe, dans l'ordre du §4.8 : compte non
   * suspendu · adresse du compte confirmée · enveloppe analysable · domaine de
   * l'enveloppe vérifié et possédé (ou adresse de test) · crédits · quota ·
   * rafale · plafond de messages de la connexion · `SIZE` annoncé.
   *
   * Les six premiers sont **un seul appel** à `precheckSmtpEnvelope` : chacune
   * de ces règles n'a qu'une implémentation, celle qu'utilise déjà `accept()`.
   * Rien n'est réécrit ici, pas même une comparaison.
   *
   * L'authentification n'apparaît pas dans la liste parce qu'elle est déjà
   * acquise : `SmtpServerService` refuse en `530` toute session anonyme avant
   * d'appeler cette méthode, et l'utilisateur authentifié est ce qu'elle reçoit
   * en argument — il n'y a pas de chemin par lequel un anonyme arriverait ici.
   */
  async mailFrom(
    address: SMTPServerAddress,
    session: SMTPServerSession,
    user: SmtpSessionUser,
  ): Promise<void> {
    await this.refusing(() =>
      this.emailsService.precheckSmtpEnvelope(user.user.id, address.address),
    );

    // Rafale (§5) : comptée **par utilisateur**, jamais par IP — le NAT
    // opérateur guinéen ferait payer à des dizaines de clients l'excès d'un
    // seul. Placée après les contrôles de compte pour ne pas consommer le
    // budget d'un message qui allait de toute façon être refusé.
    await this.smtpThrottleService.assertSendBurstWithinLimit(user.user.id);
    this.smtpThrottleService.assertMessageCountWithinLimit(session);

    this.assertAnnouncedSizeWithinLimit(address);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RCPT TO — contrôle anticipé (ne peut que refuser)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Contrôles anticipés d'un destinataire (§4.7) : adresse analysable, plafond
   * de destinataires, couverture du solde et du quota pour le **total
   * courant**.
   *
   * Tout refus est compté par `recordRefusedRecipient` (S9, anti-moissonnage
   * d'adresses) — et ce compteur peut, au-delà de son plafond, lever un `421`
   * qui **remplace** le refus et ferme la connexion. Le motif d'origine est
   * alors perdu pour le client, délibérément : lui dire pourquoi chaque adresse
   * a été refusée serait lui rendre l'information qu'on vient précisément de
   * lui couper.
   */
  async rcptTo(
    address: SMTPServerAddress,
    session: SMTPServerSession,
    user: SmtpSessionUser,
  ): Promise<void> {
    try {
      const recipient = normalizeEmailAddress(address.address);

      if (!recipient) {
        throw smtpReplyToError(SMTP_REPLY_RCPT_TO_UNREADABLE);
      }

      const total = this.recipientTotalWith(session, recipient);

      if (total > this.maxRecipients) {
        throw smtpReplyToError(SMTP_REPLY_TOO_MANY_RECIPIENTS);
      }

      await this.assertRecipientsCovered(user.user.id, total);
    } catch (error: unknown) {
      // Peut lever `421` + fermeture, qui remplace alors ce refus (§5) :
      // même mécanique que le comptage des échecs d'AUTH de S5.
      this.smtpThrottleService.recordRefusedRecipient(session);

      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DATA — le point où la décision se prend réellement
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Consomme le message, l'analyse, puis appelle le point d'acceptation pour
   * **chaque** destinataire retenu au `RCPT TO` (éventail du §4.7).
   *
   * Ordre, et pourquoi il est celui-là :
   * 1. **lire le flux jusqu'au bout**, toujours — `smtp-server` attend le point
   *    final pour reprendre la conversation, et un flux laissé en suspens gèle
   *    la connexion jusqu'au `socketTimeout` ;
   * 2. **taille** (`552`) : constatée sur les octets réellement reçus, pas sur
   *    ce que le client a annoncé — un client peut mentir sur `SIZE` ;
   * 3. **MIME** (`554`) : en-têtes illisibles, `From:` multiple ou illisible ;
   * 4. **convertibilité en UTF-8** (`554`) : contrainte de transport du job,
   *    voir {@link SMTP_REPLY_RAW_NOT_UTF8} ;
   * 5. **éventail** : `accept()` par destinataire, séquentiellement.
   *
   * Les quatre premiers refus portent sur le message entier et tombent avant
   * toute écriture : aucune ligne `Email`, aucun crédit, aucun job. Le
   * cinquième, lui, peut produire des issues différentes d'un destinataire à
   * l'autre — d'où la règle d'agrégation ci-dessous.
   *
   * @returns Le texte du `250` à rendre au client (`smtp-server` place le code
   *   lui-même). Lève une erreur de refus dans le cas contraire.
   */
  async data(
    stream: SMTPServerDataStream,
    session: SMTPServerSession,
    user: SmtpSessionUser,
  ): Promise<string> {
    const received = await this.readMessage(stream);

    if (received === null) {
      this.logger.warn(
        `Message SMTP refusé (session ${session.id}) : taille supérieure à ${this.maxMessageBytes} octets`,
      );
      throw smtpReplyToError(SMTP_REPLY_SIZE_EXCEEDED);
    }

    const analysis = analyzeRawMessage(received);

    if (!analysis.ok) {
      this.logger.warn(
        `Message SMTP refusé (session ${session.id}) : en-têtes MIME inacceptables — ${analysis.reason}`,
      );
      throw smtpReplyToError(SMTP_REPLY_MIME_INVALID);
    }

    const raw = toUtf8String(analysis.raw);

    if (raw === null) {
      this.logger.warn(
        `Message SMTP refusé (session ${session.id}) : contenu non convertible en UTF-8`,
      );
      throw smtpReplyToError(SMTP_REPLY_RAW_NOT_UTF8);
    }

    if (analysis.strippedHeaders.length > 0) {
      this.logger.log(
        `En-têtes retirés du message (session ${session.id}) : ${analysis.strippedHeaders.join(', ')}`,
      );
    }

    // L'en-tête `From:` fait foi (§4.3) : c'est lui que SES lit pour choisir
    // l'identité de signature DKIM, et lui que le destinataire voit. Sa
    // validation n'est **pas** faite ici — elle vit dans `accept()`, avec la
    // restriction du bac à sable qui l'accompagne.
    //
    // Sans `From:` d'en-tête, on retient celui de l'enveloppe : le message part
    // avec ses octets d'origine (SES posera l'en-tête manquant à partir de
    // l'expéditeur qu'on lui donne), et la ligne du journal reste juste.
    const from = analysis.from
      ? formatEmailAddress(analysis.from)
      : (session.envelope.mailFrom || { address: '' }).address;

    return this.fanOut(session, user, {
      from,
      subject: storedSubject(analysis.subject),
      raw,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Éventail multi-destinataires et réponse agrégée (§4.7)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Appelle le point d'acceptation pour chaque destinataire, puis agrège les N
   * issues en **une seule** réponse SMTP (règle d'agrégation du §4.7) :
   *
   * - **tous les destinataires refusés** → le code du **premier** refus ;
   * - **au moins une ligne `Email` créée** (acceptée ou `SUPPRESSED`) → `250`,
   *   dont le texte détaille chaque issue.
   *
   * Répondre 4xx/5xx après avoir déjà mis une partie des destinataires en file
   * ferait **rejouer tout le message** par le MTA du client : des doublons chez
   * ceux qui ont déjà été servis. C'est pire qu'une copie manquante signalée —
   * et elle est signalée, dans le texte du `250` comme au journal Zendou.
   *
   * Traitement **séquentiel** et non parallèle : les contrôles de solde et de
   * quota de `accept()` lisent l'état laissé par le destinataire précédent. En
   * parallèle, N destinataires liraient tous le même solde et pourraient le
   * dépasser ensemble.
   */
  private async fanOut(
    session: SMTPServerSession,
    user: SmtpSessionUser,
    message: { from: string; subject: string; raw: string },
  ): Promise<string> {
    const outcomes: SmtpRecipientOutcome[] = [];
    let firstRefusal: unknown = null;

    for (const recipient of session.envelope.rcptTo) {
      try {
        const accepted = await this.emailsService.acceptSmtp(user.user.id, {
          from: message.from,
          to: recipient.address,
          subject: message.subject,
          raw: message.raw,
          smtpCredentialId: user.credentialId,
        });

        this.logger.log(
          `Message SMTP accepté (session ${session.id}, identifiant ${user.credentialId}) : ${accepted.id} → ${recipient.address} [${accepted.status}]`,
        );

        outcomes.push({
          kind: accepted.status === 'suppressed' ? 'suppressed' : 'queued',
          address: recipient.address,
          publicId: accepted.id,
        });
      } catch (error: unknown) {
        firstRefusal ??= error;
        outcomes.push({
          kind: 'refused',
          address: recipient.address,
          reason: this.describeRefusal(session, recipient.address, error),
        });
      }
    }

    // Une seule fois par message, quel que soit le nombre de destinataires :
    // c'est un plafond de **conversation**, pas de facturation (les crédits se
    // débitent par destinataire, dans `accept()`).
    //
    // Compté que le message ait produit des lignes ou non : un message dont
    // l'éventail a été exécuté a bel et bien consommé la connexion. Ne compter
    // que les acceptations laisserait un client refusé en boucle marteler la
    // même connexion sans jamais atteindre son plafond.
    this.smtpThrottleService.recordMessage(session);

    if (outcomes.every((outcome) => outcome.kind === 'refused')) {
      throw smtpReplyToError(smtpReplyForError(firstRefusal));
    }

    return formatSmtpAcceptedReply(outcomes);
  }

  /**
   * Motif lisible d'un refus tardif, pour le texte du `250` agrégé.
   *
   * Toujours un texte **de notre table** (S8), jamais le message brut d'une
   * exception : une panne de base ne doit pas se raconter au client sur le
   * fil. C'est aussi le point où une erreur réellement inattendue est
   * journalisée avec sa pile — sans quoi elle disparaîtrait, absorbée par
   * l'agrégation.
   */
  private describeRefusal(
    session: SMTPServerSession,
    address: string,
    error: unknown,
  ): string {
    const reply = smtpReplyForError(error);

    if (
      sendRefusalReason(error) === null &&
      !(error instanceof HttpException)
    ) {
      this.logger.error(
        `Exception inattendue pendant l'acceptation SMTP de ${address} (session ${session.id}) — destinataire refusé en ${reply.code}`,
        error instanceof Error ? error.stack : String(error),
      );
    } else {
      this.logger.warn(
        `Destinataire ${address} refusé (session ${session.id}) : ${reply.code} ${reply.message}`,
      );
    }

    return reply.message;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Interne
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * `SIZE=` annoncé au `MAIL FROM` supérieur au plafond → `552` (§4.4), **avant**
   * l'upload.
   *
   * Doublure assumée : `smtp-server` applique déjà ce refus lui-même dès que
   * l'option `size` est posée (`lib/smtp-connection.js:1749`), avant même
   * d'appeler ce handler — c'est donc lui qu'un client rencontre en pratique.
   * Le contrôle est gardé pour les mêmes raisons que la doublure du `538` de
   * S5 : la protection ne doit pas dépendre d'une option de la bibliothèque
   * (`hideSize` la désactiverait sans un mot), et le §4.8 énumère ce contrôle
   * comme l'un des contrôles anticipés — il doit exister, et être testable, à
   * l'endroit où le plan le place.
   */
  private assertAnnouncedSizeWithinLimit(address: SMTPServerAddress): void {
    // `@types/smtp-server` type `args` en `object` nu ; la bibliothèque y range
    // les paramètres de la commande, clés en majuscules
    // (`lib/smtp-connection.js`, `_parseAddressCommand`). D'où la lecture
    // explicite plutôt qu'un accès direct que le typage refuserait.
    const announced = Number(
      (address.args as Record<string, unknown> | undefined)?.SIZE,
    );

    if (Number.isFinite(announced) && announced > this.maxMessageBytes) {
      throw smtpReplyToError(SMTP_REPLY_SIZE_EXCEEDED);
    }
  }

  /**
   * Le solde et le quota couvrent-ils `total` destinataires (§4.7) ?
   *
   * Le refus est rendu en **`452 4.5.3`** — le code du plafond de
   * destinataires — et non en `450`/`451` comme le ferait la traduction
   * ordinaire des motifs « crédits épuisés » / « quota atteint ». Ce n'est pas
   * une entorse à la table de S8, c'est la bonne lecture de la situation : à ce
   * stade, le `MAIL FROM` a déjà vérifié qu'**un** envoi est finançable et
   * l'a laissé passer. Un refus ici ne dit donc pas « vous ne pouvez plus rien
   * envoyer », il dit « **ce destinataire-là** ne rentre pas dans ce message »
   * — exactement ce que `452` signifie, et exactement ce que le §4.7 demande
   * (« on refuse le destinataire de trop en `452 4.5.3` »).
   *
   * La différence est visible pour le client : sur `450`, son MTA remet tout le
   * message à plus tard ; sur `452`, il livre aux destinataires acceptés et
   * réessaie le refusé — ce qui est le comportement voulu, puisque les
   * précédents, eux, sont bel et bien finançables.
   *
   * Une erreur qui n'est pas un refus (panne de base) n'est pas traduite : elle
   * remonte telle quelle pour être journalisée et rendue en `451`.
   */
  private async assertRecipientsCovered(
    userId: string,
    total: number,
  ): Promise<void> {
    try {
      await this.emailsService.precheckSmtpRecipients(userId, total);
    } catch (error: unknown) {
      if (sendRefusalReason(error) === null) {
        throw error;
      }

      throw smtpReplyToError(SMTP_REPLY_TOO_MANY_RECIPIENTS);
    }
  }

  /**
   * Total de destinataires qu'aurait le message si `recipient` était retenu.
   *
   * `smtp-server` **écrase** un destinataire déjà présent au lieu de l'ajouter
   * (`lib/smtp-connection.js:1834-1841`) : un client qui répète une adresse ne
   * doit donc ni consommer une place de plus, ni être facturé deux fois.
   */
  private recipientTotalWith(
    session: SMTPServerSession,
    recipient: string,
  ): number {
    const current = session.envelope.rcptTo.length;
    const duplicate = session.envelope.rcptTo.some(
      (existing) => normalizeEmailAddress(existing.address) === recipient,
    );

    return duplicate ? current : current + 1;
  }

  /**
   * Lit le flux `DATA` en entier et rend ses octets, ou `null` si le message
   * dépasse le plafond.
   *
   * Le flux est **toujours** consommé jusqu'à son terme, dépassement compris :
   * `smtp-server` attend la fin des données pour reprendre la conversation.
   * Au-delà du plafond, en revanche, plus rien n'est conservé — accumuler un
   * message qu'on vient de décider de refuser offrirait à un client hostile
   * une consommation mémoire sans limite dans le processus qui héberge aussi
   * l'API (§1.1).
   *
   * Deux détections plutôt qu'une : notre compteur d'octets **et** le drapeau
   * `sizeExceeded` de `smtp-server` (posé par l'option `size`). La première
   * tient même si l'option n'est pas posée ; la seconde tient même si le
   * plafond change entre le démarrage et la lecture.
   */
  private readMessage(stream: SMTPServerDataStream): Promise<Buffer | null> {
    const limit = this.maxMessageBytes;

    return new Promise<Buffer | null>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let exceeded = false;

      stream.on('data', (chunk: Buffer) => {
        received += chunk.length;

        if (received > limit) {
          exceeded = true;
          chunks.length = 0;
          return;
        }

        chunks.push(chunk);
      });

      stream.once('end', () => {
        resolve(exceeded || stream.sizeExceeded ? null : Buffer.concat(chunks));
      });

      stream.once('error', (error: Error) => reject(error));
    });
  }

  /**
   * Exécute un appel au point d'acceptation et traduit son refus en réponse
   * SMTP.
   *
   * Seuls les refus sont traduits : une erreur qui n'en est pas une — panne de
   * base, de Redis, bug — est **relancée telle quelle**, pour que l'enveloppe
   * anti-exception de `SmtpServerService` la journalise avec sa pile avant de
   * rendre `451`. La traduire ici donnerait le même code au client, mais
   * l'incident disparaîtrait des journaux.
   */
  private async refusing(call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error: unknown) {
      throw toSmtpRefusal(error);
    }
  }

  /**
   * Lit un réglage entier positif, avec repli sur le défaut du plan — même
   * précaution que `SmtpThrottleService` : un réglage absent donnerait `NaN`,
   * donc une comparaison toujours fausse, donc un plafond silencieusement
   * désarmé.
   */
  private setting(key: string, fallback: number): number {
    const value = this.configService.get<number>(key);

    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : fallback;
  }
}

/**
 * Traduit un refus du point d'acceptation en erreur de réponse SMTP, et laisse
 * passer tout le reste.
 */
function toSmtpRefusal(error: unknown): unknown {
  if (isSmtpReplyError(error)) {
    return error;
  }

  if (sendRefusalReason(error) !== null || error instanceof HttpException) {
    return smtpReplyToError(smtpReplyForError(error));
  }

  return error;
}

/**
 * Octets du message sous forme de chaîne UTF-8, ou `null` si la conversion est
 * avec perte.
 *
 * Le contrôle est un **aller-retour** et non une inspection : on reconvertit la
 * chaîne obtenue et on exige l'égalité octet pour octet. C'est la seule
 * vérification qui prouve ce dont on a besoin — que le message qui ressortira
 * du job BullMQ sera exactement celui qui est entré. Une heuristique sur les
 * octets (chercher `U+FFFD`, tester des plages) laisserait passer les cas
 * limites ; l'aller-retour n'en laisse passer aucun.
 */
export function toUtf8String(raw: Buffer): string | null {
  const text = raw.toString('utf8');

  return Buffer.from(text, 'utf8').equals(raw) ? text : null;
}

/**
 * Sujet inscrit sur la ligne `Email` (§4.6, A12).
 *
 * Absent **ou vide** → « (sans objet) » : `Subject:` absent ressort en
 * `undefined`, `Subject:` présent mais vide en chaîne vide, et les deux
 * appellent le même repli — tester la valeur, pas seulement sa présence.
 *
 * Au-delà de 300 caractères, tronqué **pour le stockage seulement** : le vrai
 * en-tête part intact dans les octets d'origine. C'est un argument de plus pour
 * le contenu Raw — en `Simple`, tronquer aurait modifié le message réellement
 * envoyé.
 */
export function storedSubject(subject: string | undefined): string {
  const decoded = (subject ?? '').trim();

  return decoded ? decoded.slice(0, SUBJECT_MAX_LENGTH) : SUBJECT_ABSENT_LABEL;
}

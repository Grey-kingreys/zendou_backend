/** Réponse à `POST /v1/emails` : l'envoi est accepté, pas encore effectué. */
export interface SendEmailResponse {
  /** Identifiant public de l'email (`e_` + 12 hexadécimaux). */
  id: string;
  /** `queued` : mis en file. `suppressed` : bloqué par la liste de suppression. */
  status: 'queued' | 'suppressed';
}

/**
 * Job d'un message composé par Zendou (canal API et envois système).
 *
 * 🔴 `kind` est **optionnel, et c'est délibéré** : un job déjà en file au
 * moment du déploiement qui introduit le canal Raw n'a pas ce champ. Un job
 * sans `kind` est simple — c'était alors le seul contenu possible. Rendre ce
 * champ obligatoire ferait perdre tous les emails en vol au redémarrage du
 * worker.
 */
export interface SimpleEmailSendJobData {
  emailId: string;
  kind?: 'simple';
  html?: string;
  text?: string;
  /**
   * Adresse de réponse déjà normalisée et **déjà validée** par le point
   * d'acceptation (domaine vérifié et possédé, comme le `From:`). Elle voyage
   * dans le job comme les corps : le modèle `Email` ne la stocke pas.
   *
   * Absente du contenu `raw` : là, l'en-tête `Reply-To:` est déjà dans les
   * octets MIME du client, et ces octets partent tels quels.
   */
  replyTo?: string;
}

/**
 * Job d'un message MIME déjà composé par le client (relais SMTP) : les octets
 * d'origine sont transmis tels quels à SES, jamais recomposés.
 *
 * `raw` est une **chaîne et non un `Buffer`** : la charge utile BullMQ est
 * sérialisée en JSON, et un `Buffer` n'y survivrait pas — il ressortirait du
 * job en `{ type: 'Buffer', data: [...] }`.
 */
export interface RawEmailSendJobData {
  emailId: string;
  kind: 'raw';
  raw: string;
}

/**
 * Charge utile du job BullMQ.
 *
 * `emailId` est l'identifiant interne de la ligne `Email` : le worker y
 * relit expéditeur, destinataire, sujet et statut. Le corps du message
 * voyage en revanche dans le job — le modèle `Email` ne le stocke pas.
 */
export type EmailSendJobData = SimpleEmailSendJobData | RawEmailSendJobData;

/**
 * Point d'entrée par lequel un envoi client est arrivé.
 *
 * Persisté sur `Email.channel` (enum Prisma `EmailChannel`, colonne ajoutée
 * par B6/S2, câblée par B6/S7). Les valeurs sont volontairement celles de
 * l'enum Prisma, à la casse près : aucune table de correspondance à tenir.
 */
export type SendChannel = 'API' | 'SMTP';

/**
 * Contenu d'un envoi, en union discriminée.
 *
 * - `simple` : ce que porte l'API REST — `html` et/ou `text`, que le driver
 *   SES envoie en `Content.Simple`.
 * - `raw` : les octets MIME d'origine du client SMTP, transmis tels quels
 *   (pièces jointes, images en ligne, en-têtes personnalisés) jusqu'au job
 *   (`RawEmailSendJobData`) puis au driver (`Content.Raw`, B6/S3).
 */
export type SendContent =
  | { kind: 'simple'; html?: string; text?: string }
  | { kind: 'raw'; raw: Buffer | string };

/**
 * Entrée du point d'acceptation partagé (`EmailsService.accept`).
 *
 * Volontairement indépendante de `SendEmailDto` : `accept` ne doit rien savoir
 * de HTTP ni de `class-validator`, sans quoi un second point d'entrée devrait
 * fabriquer un DTO de requête pour s'en servir.
 */
export interface AcceptEmailInput {
  /** Adresse d'expédition, nue ou sous forme « Nom <adresse> ». */
  from: string;
  /** Destinataire unique (un seul en v1, comme sur l'API). */
  to: string;
  /** Sujet, tel qu'il sera tracé sur la ligne `Email`. */
  subject: string;
  /**
   * Adresses de réponse demandées, dans leur forme brute (`adresse@domaine` ou
   * « Nom <adresse> »), avant toute validation.
   *
   * Une liste, et non une adresse unique : l'API n'en accepte qu'une, mais un
   * en-tête `Reply-To:` reçu par le relais SMTP peut en porter plusieurs
   * (RFC 5322). Chacune subit exactement la règle du `From:` - la première qui
   * échoue refuse tout le message.
   */
  replyTo?: string[];
  content: SendContent;
  channel: SendChannel;
  /** Identifiant SMTP utilisé, quand l'envoi vient du relais (B6/S4). */
  smtpCredentialId?: string;
}

/**
 * Entrée d'`EmailsService.acceptSmtp` — un destinataire du relais SMTP.
 *
 * Volontairement plus étroite qu'`AcceptEmailInput` : le canal et la forme du
 * contenu ne sont pas des choix laissés à l'appelant SMTP (`channel: 'SMTP'`,
 * `content.kind: 'raw'`, A8 — « le canal SMTP est Raw de bout en bout »), et
 * `smtpCredentialId` y est **obligatoire** puisqu'aucun message ne peut
 * arriver par ce canal sans identifiant authentifié (§5, pas d'open relay).
 *
 * `raw` est une **chaîne UTF-8, pas un `Buffer`** : le contrôle d'aller-retour
 * qui garantit que ces octets survivront à la sérialisation JSON de BullMQ
 * appartient au relais, en amont, où un contenu non convertible peut encore
 * être refusé avec un code SMTP explicite (`554`). Le point d'acceptation, lui,
 * n'a pas à connaître cette contrainte de transport.
 */
export interface AcceptSmtpInput {
  /** Adresse d'expédition — l'en-tête `From:` du message, qui fait foi (§4.3). */
  from: string;
  /** Destinataire unique : l'éventail multi-destinataires appelle N fois. */
  to: string;
  /** Sujet destiné au journal, déjà décodé et tronqué par l'appelant (§4.6). */
  subject: string;
  /**
   * Boîtes aux lettres de l'en-tête `Reply-To:`, telles que l'analyse MIME les
   * a découpées - non validées. Le point d'acceptation leur applique la règle
   * du `From:` : aucun en-tête n'est réécrit, on refuse le message entier.
   */
  replyTo?: string[];
  /** Octets MIME réécrits (sans `Bcc:`…), tels qu'ils partiront chez SES. */
  raw: string;
  /** Identifiant SMTP de la session, tracé sur la ligne `Email` (§6, A15). */
  smtpCredentialId: string;
}

/**
 * Envoi émis par Zendou lui-même (confirmation d'adresse…).
 *
 * `userId` est le **destinataire** — le compte concerné par le message — et
 * non un expéditeur : l'expéditeur est toujours `SYSTEM_EMAIL_FROM`. C'est ce
 * qui permet de consulter la liste de suppression propre à ce compte comme on
 * le ferait pour un envoi client.
 */
export interface SystemEmailPayload {
  userId: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

/**
 * Issue d'un envoi système. `suppressed` n'est pas une erreur : l'adresse est
 * sur la liste de suppression, rien n'a été mis en file, et l'appelant doit
 * le dire à l'utilisateur plutôt que de lui faire attendre un email qui
 * n'arrivera jamais.
 */
export interface SystemSendResult {
  status: 'queued' | 'suppressed';
  /** Identifiant public de l'email tracé — absent si l'envoi a été supprimé. */
  id?: string;
}

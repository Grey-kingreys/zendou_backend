/** Réponse à `POST /v1/emails` : l'envoi est accepté, pas encore effectué. */
export interface SendEmailResponse {
  /** Identifiant public de l'email (`e_` + 12 hexadécimaux). */
  id: string;
  /** `queued` : mis en file. `suppressed` : bloqué par la liste de suppression. */
  status: 'queued' | 'suppressed';
}

/**
 * Charge utile du job BullMQ.
 *
 * `emailId` est l'identifiant interne de la ligne `Email` : le worker y
 * relit expéditeur, destinataire, sujet et statut. Le corps du message
 * voyage en revanche dans le job — le modèle `Email` ne le stocke pas.
 */
export interface EmailSendJobData {
  emailId: string;
  html?: string;
  text?: string;
}

/**
 * Point d'entrée par lequel un envoi client est arrivé.
 *
 * Transite dans `AcceptEmailInput` sans être encore persisté : la colonne
 * `Email.channel` (enum Prisma `EmailChannel`) est ajoutée par une migration
 * séparée (B6/S2), et la persistance sera câblée à ce moment-là.
 */
export type SendChannel = 'API' | 'SMTP';

/**
 * Contenu d'un envoi, en union discriminée.
 *
 * - `simple` : ce que porte l'API REST — `html` et/ou `text`, que le driver
 *   SES envoie en `Content.Simple`.
 * - `raw` : les octets MIME d'origine du client SMTP, transmis tels quels
 *   (pièces jointes, images en ligne, en-têtes personnalisés). **Non encore
 *   câblé** jusqu'au job ni jusqu'au driver : c'est le périmètre de B6/S3, qui
 *   ajoutera le discriminant à `EmailSendJobData` et à `SesSendPayload`.
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
  content: SendContent;
  channel: SendChannel;
  /** Identifiant SMTP utilisé, quand l'envoi vient du relais (B6/S4). */
  smtpCredentialId?: string;
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

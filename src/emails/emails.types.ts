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

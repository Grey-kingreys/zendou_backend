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

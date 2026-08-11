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

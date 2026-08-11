/**
 * Types des messages Amazon SNS et des événements SES qu'ils transportent.
 *
 * SNS enveloppe l'événement SES : le champ `Message` d'une `Notification`
 * contient le JSON SES **sérialisé en chaîne**.
 */

export const SNS_MESSAGE_TYPES = [
  'SubscriptionConfirmation',
  'Notification',
  'UnsubscribeConfirmation',
] as const;

export type SnsMessageType = (typeof SNS_MESSAGE_TYPES)[number];

/** Enveloppe SNS telle que postée sur le webhook (Content-Type text/plain). */
export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  /** Présent sur SubscriptionConfirmation / UnsubscribeConfirmation. */
  Token?: string;
  SubscribeURL?: string;
  UnsubscribeURL?: string;
}

/** Bloc `mail` commun à tous les événements SES. */
export interface SesMail {
  timestamp?: string;
  source?: string;
  messageId?: string;
  destination?: string[];
}

export interface SesBouncedRecipient {
  emailAddress?: string;
  action?: string;
  status?: string;
  diagnosticCode?: string;
}

export interface SesBounce {
  bounceType?: string;
  bounceSubType?: string;
  bouncedRecipients?: SesBouncedRecipient[];
  timestamp?: string;
  feedbackId?: string;
  reportingMTA?: string;
}

export interface SesComplainedRecipient {
  emailAddress?: string;
}

export interface SesComplaint {
  complainedRecipients?: SesComplainedRecipient[];
  timestamp?: string;
  feedbackId?: string;
  complaintFeedbackType?: string;
  complaintSubType?: string | null;
  userAgent?: string;
  arrivalDate?: string;
}

export interface SesDelivery {
  timestamp?: string;
  processingTimeMillis?: number;
  recipients?: string[];
  smtpResponse?: string;
  reportingMTA?: string;
}

/**
 * Payload SES. Le type d'événement est porté par `eventType` (event
 * publishing via configuration set) ou `notificationType` (abonnement SNS
 * historique sur l'identité) — on accepte les deux.
 */
export interface SesEventPayload {
  eventType?: string;
  notificationType?: string;
  mail?: SesMail;
  bounce?: SesBounce;
  complaint?: SesComplaint;
  delivery?: SesDelivery;
}

/** Un bounce `Permanent` est définitif : l'adresse part en suppression. */
export const PERMANENT_BOUNCE_TYPE = 'Permanent';

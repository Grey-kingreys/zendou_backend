/** Token d'injection du driver d'envoi SES. */
export const SES_SEND_DRIVER = 'SES_SEND_DRIVER';

/** Message à remettre à SES. Un seul destinataire en v1. */
export interface SesSendPayload {
  /** Expéditeur, `adresse@domaine` ou `Nom <adresse@domaine>`. */
  from: string;
  /** Destinataire unique. */
  to: string;
  subject: string;
  html?: string;
  text?: string;
  /** Surcharge ponctuelle du configuration set du driver. */
  configurationSet?: string;
}

export interface SesSendResult {
  /** Identifiant SES du message accepté. */
  messageId: string;
}

/**
 * Abstraction de l'envoi d'un email. Deux implémentations, sur le même
 * principe que le driver d'identités : `SesSendSdkDriver` (SESv2 réel) et
 * `SendDevStubDriver` (développement local, sans clés AWS).
 */
export interface SesSendDriver {
  send(payload: SesSendPayload): Promise<SesSendResult>;
}

/**
 * Nature d'un échec d'envoi :
 * - `PERMANENT` : réessayer ne changera rien (message rejeté, identité non
 *   vérifiée, compte suspendu) — l'email part directement en `FAILED` ;
 * - `TRANSIENT` : la même requête peut aboutir plus tard (throttling,
 *   panne SES, réseau) — le job est relancé par BullMQ.
 */
export type SesSendErrorKind = 'PERMANENT' | 'TRANSIENT';

/**
 * Erreur d'envoi normalisée. C'est le discriminant que lit le worker : il
 * n'a jamais à connaître les noms d'exception du SDK AWS.
 */
export class SesSendError extends Error {
  readonly kind: SesSendErrorKind;

  constructor(
    kind: SesSendErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SesSendError';
    this.kind = kind;
  }

  /** Vrai lorsque toute nouvelle tentative est vouée à l'échec. */
  get permanent(): boolean {
    return this.kind === 'PERMANENT';
  }
}

/**
 * Vrai si l'échec est définitif. Toute erreur non classée (y compris une
 * erreur inattendue hors driver) est considérée comme temporaire : mieux
 * vaut retenter que perdre un email par excès de zèle.
 */
export function isPermanentSendError(error: unknown): boolean {
  return error instanceof SesSendError && error.kind === 'PERMANENT';
}

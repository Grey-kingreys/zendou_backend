import type { EmailChannel, EmailStatus } from '@prisma/client';

/**
 * Query brute reçue par le contrôleur (tous les champs arrivent en string
 * depuis Express — le `ValidationPipe` global n'a pas `transform: true`).
 * Le parsing/validation est fait explicitement dans `EmailsLogService`.
 */
export interface RawEmailsListQuery {
  status?: string;
  channel?: string;
  page?: string;
  limit?: string;
  from?: string;
  to?: string;
  q?: string;
}

/** Ligne du journal des envois telle qu'exposée par la liste paginée. */
export interface EmailListItem {
  publicId: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  status: EmailStatus;
  channel: EmailChannel;
  queuedAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  lastEventAt: Date | null;
}

/**
 * Détail complet d'un envoi (jamais l'id interne cuid ni le userId).
 * `smtpCredentialId` : quel identifiant SMTP a expédié cet envoi (`null`
 * pour le canal API, ou pour un envoi SMTP dont l'identifiant a depuis été
 * révoqué/purgé — voir `Email.smtpCredential` en base, `onDelete: SetNull`).
 */
export interface EmailDetail extends EmailListItem {
  errorMessage: string | null;
  sesMessageId: string | null;
  smtpCredentialId: string | null;
}

export interface PaginatedEmails {
  items: EmailListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

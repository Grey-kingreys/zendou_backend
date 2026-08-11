import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type {
  SesSendDriver,
  SesSendPayload,
  SesSendResult,
} from './ses-send-driver';

/** Octets aléatoires du `messageId` simulé (8 octets → 16 hexadécimaux). */
const STUB_MESSAGE_ID_BYTES = 8;

/**
 * Driver de développement : aucun appel réseau, aucune clé AWS requise.
 * L'envoi réussit toujours et l'email est tracé dans les logs — de quoi
 * dérouler tout le pipeline en local sans compte SES.
 */
export class SendDevStubDriver implements SesSendDriver {
  private readonly logger = new Logger('SesSendDriver');

  send(payload: SesSendPayload): Promise<SesSendResult> {
    const messageId = stubMessageId();

    this.logger.log(
      `[SES send stub] ${payload.from} → ${payload.to} · « ${payload.subject} » · ${describeBody(payload)} → ${messageId}`,
    );

    return Promise.resolve({ messageId });
  }
}

/** Génère un identifiant de message simulé, reconnaissable à son préfixe. */
export function stubMessageId(): string {
  return `stub-${randomBytes(STUB_MESSAGE_ID_BYTES).toString('hex')}`;
}

/** Résume les variantes de corps présentes, pour la ligne de log. */
function describeBody(payload: SesSendPayload): string {
  const parts: string[] = [];

  if (payload.html) {
    parts.push(`html ${payload.html.length} car.`);
  }

  if (payload.text) {
    parts.push(`text ${payload.text.length} car.`);
  }

  return parts.length > 0 ? parts.join(' + ') : 'sans contenu';
}

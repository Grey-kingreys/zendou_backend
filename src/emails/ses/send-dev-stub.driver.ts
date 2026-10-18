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

/**
 * Résume le contenu pour la ligne de log.
 *
 * Un message brut est décrit par sa **taille en octets, jamais par son
 * contenu** : il porte le corps composé par le client, pièces jointes
 * comprises, et les logs applicatifs ne sont pas l'endroit où le déverser.
 */
function describeBody(payload: SesSendPayload): string {
  if (payload.kind === 'raw') {
    return `raw ${rawByteLength(payload.raw)} o.`;
  }

  const parts: string[] = [];

  if (payload.html) {
    parts.push(`html ${payload.html.length} car.`);
  }

  if (payload.text) {
    parts.push(`text ${payload.text.length} car.`);
  }

  if (payload.headers && Object.keys(payload.headers).length > 0) {
    parts.push(`en-têtes ${Object.keys(payload.headers).join(', ')}`);
  }

  return parts.length > 0 ? parts.join(' + ') : 'sans contenu';
}

/** Taille du message brut, cohérente avec ce qui partirait chez SES. */
function rawByteLength(raw: Buffer | string): number {
  return typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length;
}

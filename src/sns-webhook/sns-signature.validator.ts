import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, createVerify } from 'node:crypto';
import { SnsHttpClient } from './sns-http.client';
import type { SnsMessage } from './sns-webhook.types';

/**
 * Champs entrant dans la chaîne à signer, dans l'ordre imposé par SNS
 * (ordre alphabétique, champs absents ignorés).
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */
const SIGNED_FIELDS: Record<'notification' | 'subscription', string[]> = {
  notification: [
    'Message',
    'MessageId',
    'Subject',
    'Timestamp',
    'TopicArn',
    'Type',
  ],
  subscription: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};

const SIGNATURE_ALGORITHMS: Record<string, string> = {
  '1': 'RSA-SHA1',
  '2': 'RSA-SHA256',
};

/** Seuls les hôtes SNS d'AWS sont acceptés (certificat, SubscribeURL). */
const SNS_HOST_PATTERN = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

/**
 * Une URL est de confiance si elle est en HTTPS **et** hébergée sur un
 * domaine SNS d'AWS. Sans ce contrôle, un attaquant ferait pointer
 * `SigningCertURL` sur son propre certificat et signerait ce qu'il veut.
 */
export function isTrustedSnsUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) {
    return false;
  }

  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && SNS_HOST_PATTERN.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Vérifie la signature RSA des messages SNS (SignatureVersion 1 = SHA1,
 * 2 = SHA256). Sans cette vérification, n'importe qui pourrait POSTer un
 * faux bounce et faire suppressor des adresses arbitraires.
 */
@Injectable()
export class SnsSignatureValidator {
  private readonly logger = new Logger(SnsSignatureValidator.name);
  /** Certificats SNS mis en cache par URL (PEM). */
  private readonly certificateCache = new Map<string, string>();
  private skipWarningEmitted = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpClient: SnsHttpClient,
  ) {}

  /** `true` si le message est authentique (ou si la validation est désactivée). */
  async isValid(message: SnsMessage): Promise<boolean> {
    if (this.signatureValidationSkipped()) {
      if (!this.skipWarningEmitted) {
        this.skipWarningEmitted = true;
        this.logger.warn(
          'SNS_SKIP_SIGNATURE_VALIDATION actif — les signatures SNS ne sont PAS vérifiées (hors production uniquement)',
        );
      }
      return true;
    }

    try {
      const algorithm = SIGNATURE_ALGORITHMS[message.SignatureVersion];
      if (!algorithm) {
        this.logger.warn(
          `SignatureVersion non supportée: ${message.SignatureVersion}`,
        );
        return false;
      }

      if (!message.Signature) {
        this.logger.warn('Message SNS sans signature');
        return false;
      }

      if (!isTrustedSnsUrl(message.SigningCertURL)) {
        this.logger.warn(
          `SigningCertURL non fiable: ${message.SigningCertURL ?? '(absente)'}`,
        );
        return false;
      }

      const certificate = await this.fetchCertificate(message.SigningCertURL);
      const stringToSign = buildStringToSign(message);

      const verified = createVerify(algorithm)
        .update(stringToSign, 'utf8')
        .verify(createPublicKey(certificate), message.Signature, 'base64');

      if (!verified) {
        this.logger.warn(
          `Signature SNS invalide (MessageId=${message.MessageId ?? 'inconnu'})`,
        );
      }

      return verified;
    } catch (error) {
      this.logger.warn(
        `Vérification de signature SNS impossible: ${describeError(error)}`,
      );
      return false;
    }
  }

  /** Même contrôle d'hôte que pour le certificat, réutilisé par le service. */
  isTrustedUrl(url: string | undefined): boolean {
    return isTrustedSnsUrl(url);
  }

  private async fetchCertificate(url: string): Promise<string> {
    const cached = this.certificateCache.get(url);
    if (cached) {
      return cached;
    }

    const certificate = await this.httpClient.get(url);
    this.certificateCache.set(url, certificate);
    return certificate;
  }

  /**
   * Le contournement n'est jamais accepté en production, quelle que soit la
   * valeur de la variable d'environnement.
   */
  private signatureValidationSkipped(): boolean {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      return false;
    }

    return (
      this.configService.get<boolean>('SNS_SKIP_SIGNATURE_VALIDATION') === true
    );
  }
}

/**
 * Construit la chaîne canonique `champ\nvaleur\n` attendue par SNS.
 * Les champs absents (ex. `Subject`) sont simplement omis.
 */
export function buildStringToSign(message: SnsMessage): string {
  const fields =
    message.Type === 'Notification'
      ? SIGNED_FIELDS.notification
      : SIGNED_FIELDS.subscription;

  const record = message as unknown as Record<string, unknown>;

  return fields
    .filter((field) => typeof record[field] === 'string')
    .map((field) => `${field}\n${record[field] as string}\n`)
    .join('');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

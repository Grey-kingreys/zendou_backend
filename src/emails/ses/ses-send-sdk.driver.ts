import {
  SendEmailCommand,
  SESv2Client,
  type Body as SesBody,
  type EmailContent as SesEmailContent,
} from '@aws-sdk/client-sesv2';
import {
  SesSendError,
  type SesSendDriver,
  type SesSendErrorKind,
  type SesSendPayload,
  type SesSendResult,
  type SesSendSimplePayload,
} from './ses-send-driver';

/** Jeu de caractères déclaré à SES pour le sujet et le corps. */
const CHARSET = 'UTF-8';

/** Encodage retenu pour un message brut fourni sous forme de chaîne. */
const RAW_ENCODING = 'utf8';

/**
 * Exceptions SES définitives : l'appel est rejeté pour une raison qui ne
 * disparaîtra pas d'elle-même dans les minutes qui suivent.
 */
const PERMANENT_ERROR_NAMES = new Set([
  'AccountSuspendedException',
  'BadRequestException',
  'LimitExceededException',
  'MailFromDomainNotVerifiedException',
  'MessageRejected',
  'NotFoundException',
  'SendingPausedException',
  'ValidationException',
]);

/** Exceptions SES temporaires : la même requête peut aboutir plus tard. */
const TRANSIENT_ERROR_NAMES = new Set([
  'ConcurrentModificationException',
  'InternalServiceErrorException',
  'RequestTimeout',
  'RequestTimeoutException',
  'ThrottlingException',
  'TimeoutError',
  'TooManyRequestsException',
]);

/** Codes d'erreur réseau Node : toujours temporaires. */
const TRANSIENT_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

export interface SesSendSdkDriverOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Configuration set SES appliqué par défaut à chaque envoi. */
  configurationSet?: string;
}

/**
 * Implémentation réelle sur l'API Amazon SES v2 (`SendEmail`, contenu
 * `Simple` ou `Raw`). Toute erreur remontée est convertie en `SesSendError`
 * pour que le worker sache s'il doit retenter ou abandonner.
 */
export class SesSendSdkDriver implements SesSendDriver {
  private readonly client: SESv2Client;
  private readonly configurationSet?: string;

  constructor(options: SesSendSdkDriverOptions) {
    this.client = new SESv2Client({
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
    this.configurationSet = options.configurationSet;
  }

  async send(payload: SesSendPayload): Promise<SesSendResult> {
    const configurationSet = payload.configurationSet ?? this.configurationSet;

    try {
      const response = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: payload.from,
          // `Destination` est fourni sur les DEUX chemins, avec la seule
          // adresse de la ligne `Email` traitée. C'est ce qui rend l'éventail
          // multi-destinataires exact et la fuite d'un `Bcc:` resté dans les
          // octets bruts structurellement impossible : SES ne livre qu'ici.
          Destination: {
            ToAddresses: [
              (payload.kind === 'simple' && payload.toDisplay) || payload.to,
            ],
          },
          Content: buildContent(payload),
          // Contenu `Simple` seulement : c'est SES qui compose le MIME, donc
          // lui qui doit poser l'en-tête `Reply-To:`. En `Raw`, l'en-tête est
          // déjà dans les octets du client - le lui ajouter ici en créerait un
          // second.
          ...(payload.kind === 'simple' && payload.replyTo
            ? { ReplyToAddresses: [payload.replyTo] }
            : {}),
          ...(configurationSet
            ? { ConfigurationSetName: configurationSet }
            : {}),
        }),
      );

      if (!response.MessageId) {
        // Cas anormal : on retente plutôt que de marquer l'email envoyé
        // sans identifiant de suivi.
        throw new SesSendError(
          'TRANSIENT',
          "SES a accepté l'appel sans retourner de MessageId",
        );
      }

      return { messageId: response.MessageId };
    } catch (error) {
      throw toSesSendError(error);
    }
  }
}

/**
 * Construit le contenu SES selon la forme du message. Le chemin `simple` est
 * exactement celui d'avant l'introduction du canal Raw — sujet et corps
 * assemblés par SES ; le chemin `raw` remet les octets tels quels, le SDK se
 * chargeant de leur encodage base64 sur le fil.
 */
export function buildContent(payload: SesSendPayload): SesEmailContent {
  if (payload.kind === 'raw') {
    return { Raw: { Data: toRawBytes(payload.raw) } };
  }

  return {
    Simple: {
      Subject: { Data: payload.subject, Charset: CHARSET },
      Body: buildBody(payload),
      ...(payload.headers && Object.keys(payload.headers).length > 0
        ? {
            Headers: Object.entries(payload.headers).map(([Name, Value]) => ({
              Name,
              Value,
            })),
          }
        : {}),
    },
  };
}

/** Octets MIME à remettre à SES, sans réécriture ni recomposition. */
export function toRawBytes(raw: Buffer | string): Uint8Array {
  return typeof raw === 'string' ? Buffer.from(raw, RAW_ENCODING) : raw;
}

/** Construit le corps SES à partir des variantes fournies. */
export function buildBody(payload: SesSendSimplePayload): SesBody {
  const body: SesBody = {};

  if (payload.html) {
    body.Html = { Data: payload.html, Charset: CHARSET };
  }

  if (payload.text) {
    body.Text = { Data: payload.text, Charset: CHARSET };
  }

  return body;
}

/**
 * Classe une erreur d'envoi. L'ordre compte : le nom de l'exception SES
 * prime, puis le code réseau, puis le statut HTTP. Un 4xx inconnu est
 * définitif, tout le reste est retentable.
 */
export function classifySesSendError(error: unknown): SesSendErrorKind {
  if (error instanceof SesSendError) {
    return error.kind;
  }

  const name = readString(error, 'name');
  if (name && PERMANENT_ERROR_NAMES.has(name)) {
    return 'PERMANENT';
  }
  if (name && TRANSIENT_ERROR_NAMES.has(name)) {
    return 'TRANSIENT';
  }

  const code = readString(error, 'code');
  if (code && TRANSIENT_ERROR_CODES.has(code)) {
    return 'TRANSIENT';
  }

  const status = readHttpStatusCode(error);
  if (status !== undefined) {
    if (status === 429 || status >= 500) {
      return 'TRANSIENT';
    }
    if (status >= 400) {
      return 'PERMANENT';
    }
  }

  return 'TRANSIENT';
}

/** Normalise n'importe quelle erreur en `SesSendError` classée. */
export function toSesSendError(error: unknown): SesSendError {
  if (error instanceof SesSendError) {
    return error;
  }

  return new SesSendError(classifySesSendError(error), describeError(error), {
    cause: error,
  });
}

/**
 * Noms d'erreur qui n'apprennent rien : `SesSendError` n'est qu'une
 * enveloppe, et son message reprend déjà celui de l'exception d'origine.
 */
const UNINFORMATIVE_ERROR_NAMES = new Set(['Error', 'SesSendError']);

/** Résumé lisible d'une erreur, destiné à `Email.errorMessage`. */
export function describeError(error: unknown): string {
  const name = readString(error, 'name');
  const message = readString(error, 'message') ?? String(error);

  return name && !UNINFORMATIVE_ERROR_NAMES.has(name)
    ? `${name}: ${message}`
    : message;
}

function readString(error: unknown, key: string): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[key];

  return typeof value === 'string' && value ? value : undefined;
}

function readHttpStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const metadata = (error as Record<string, unknown>).$metadata;

  if (typeof metadata !== 'object' || metadata === null) {
    return undefined;
  }

  const status = (metadata as Record<string, unknown>).httpStatusCode;

  return typeof status === 'number' ? status : undefined;
}

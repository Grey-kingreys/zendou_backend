import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { SnsSignatureValidator } from './sns-signature.validator';
import { SnsWebhookService } from './sns-webhook.service';
import type { SnsMessage } from './sns-webhook.types';

export interface SnsWebhookAck {
  received: true;
}

/**
 * Webhook public appelé par Amazon SNS (aucune authentification
 * utilisateur : l'authenticité repose entièrement sur la signature).
 *
 * SNS poste du JSON avec `Content-Type: text/plain; charset=UTF-8` — le
 * corps est lu en texte brut par le middleware du module puis parsé ici.
 */
@Controller('webhooks/sns')
export class SnsWebhookController {
  private readonly logger = new Logger(SnsWebhookController.name);

  constructor(
    private readonly signatureValidator: SnsSignatureValidator,
    private readonly snsWebhookService: SnsWebhookService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() request: Request): Promise<SnsWebhookAck> {
    const message = parseSnsMessage(request.body);

    if (!message) {
      this.logger.warn('Corps de requête SNS illisible ou non conforme');
      throw new BadRequestException('Message SNS invalide');
    }

    if (!(await this.signatureValidator.isValid(message))) {
      // Seul cas où l'on ne répond pas 200 : quelqu'un tente de nous faire
      // avaler un faux événement.
      throw new ForbiddenException('Signature SNS invalide');
    }

    try {
      await this.snsWebhookService.handle(message);
    } catch (error) {
      // SNS retente sur toute réponse non-2xx : on acquitte quand même et
      // on garde la trace de l'incident côté logs.
      this.logger.error(
        `Traitement de l'événement SNS ${message.MessageId ?? 'inconnu'} en échec`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return { received: true };
  }
}

/** Accepte le corps sous forme de texte (cas SNS), de Buffer ou d'objet déjà parsé. */
function parseSnsMessage(body: unknown): SnsMessage | undefined {
  let candidate: unknown = body;

  if (Buffer.isBuffer(body)) {
    candidate = body.toString('utf8');
  }

  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }

  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof (candidate as { Type?: unknown }).Type !== 'string'
  ) {
    return undefined;
  }

  return candidate as SnsMessage;
}

import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { text } from 'express';
import { SnsHttpClient } from './sns-http.client';
import { SnsSignatureValidator } from './sns-signature.validator';
import { SnsWebhookController } from './sns-webhook.controller';
import { SnsWebhookService } from './sns-webhook.service';

/** Un message SNS dépasse rarement quelques dizaines de Ko. */
const MAX_BODY_SIZE = '256kb';

@Module({
  controllers: [SnsWebhookController],
  providers: [SnsWebhookService, SnsSignatureValidator, SnsHttpClient],
})
export class SnsWebhookModule implements NestModule {
  /**
   * SNS poste du JSON en `text/plain; charset=UTF-8` : le parser JSON global
   * laisse alors le corps vide. On ajoute un parser texte **uniquement** sur
   * la route du webhook (les requêtes déjà parsées en JSON sont ignorées par
   * body-parser, le parser global reste donc intact).
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        text({ type: ['text/*', 'application/json'], limit: MAX_BODY_SIZE }),
      )
      .forRoutes({ path: 'webhooks/sns', method: RequestMethod.POST });
  }
}

import { Test, TestingModule } from '@nestjs/testing';
import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { deliveryFixture, permanentBounceFixture } from './fixtures';
import { SnsSignatureValidator } from './sns-signature.validator';
import { SnsWebhookModule } from './sns-webhook.module';
import { SnsWebhookService } from './sns-webhook.service';

/**
 * Test léger de bout en bout du contrôleur : on garde le vrai module (donc
 * le middleware qui lit le corps en `text/plain`, comme SNS l'envoie) et on
 * ne remplace que la validation de signature et le traitement métier.
 */
describe('SnsWebhookController (HTTP)', () => {
  let app: INestApplication<App>;

  const snsWebhookService = { handle: jest.fn() };
  const signatureValidator = { isValid: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    snsWebhookService.handle.mockResolvedValue(undefined);
    signatureValidator.isValid.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      imports: [SnsWebhookModule],
    })
      .overrideProvider(SnsWebhookService)
      .useValue(snsWebhookService)
      .overrideProvider(SnsSignatureValidator)
      .useValue(signatureValidator)
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('parses the body SNS actually sends (JSON in text/plain)', async () => {
    const fixture = deliveryFixture();

    const response = await request(app.getHttpServer())
      .post('/webhooks/sns')
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .send(JSON.stringify(fixture));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    // Le corps text/plain a bien été parsé : le message reçu est identique
    // à la fixture, champ pour champ.
    expect(snsWebhookService.handle).toHaveBeenCalledWith(fixture);
    expect(signatureValidator.isValid).toHaveBeenCalledWith(fixture);
  });

  it('still accepts a body sent as application/json', async () => {
    const fixture = permanentBounceFixture();

    const response = await request(app.getHttpServer())
      .post('/webhooks/sns')
      .set('Content-Type', 'application/json')
      .send(fixture);

    expect(response.status).toBe(200);
    expect(snsWebhookService.handle).toHaveBeenCalledWith(fixture);
  });

  it('answers 403 and writes nothing when the signature is invalid', async () => {
    signatureValidator.isValid.mockResolvedValue(false);

    const response = await request(app.getHttpServer())
      .post('/webhooks/sns')
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .send(JSON.stringify(permanentBounceFixture()));

    expect(response.status).toBe(403);
    expect(snsWebhookService.handle).not.toHaveBeenCalled();
  });

  it('rejects a body that is not a SNS message', async () => {
    const response = await request(app.getHttpServer())
      .post('/webhooks/sns')
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .send('<not json>');

    expect(response.status).toBe(400);
    expect(signatureValidator.isValid).not.toHaveBeenCalled();
    expect(snsWebhookService.handle).not.toHaveBeenCalled();
  });

  it('acknowledges with 200 even when processing blows up (SNS would retry)', async () => {
    snsWebhookService.handle.mockRejectedValue(new Error('base indisponible'));
    const loggedError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const response = await request(app.getHttpServer())
      .post('/webhooks/sns')
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .send(JSON.stringify(deliveryFixture()));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(loggedError).toHaveBeenCalled();

    loggedError.mockRestore();
  });
});

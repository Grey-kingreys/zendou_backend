import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { HttpStatus } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApiKeyAuthGuard } from '../api-keys';
import { EMAIL_NOT_VERIFIED_MESSAGE, EmailVerifiedGuard } from '../auth';
import type { AuthenticatedRequest, AuthUser } from '../auth';
import type { SendEmailDto } from './dto/send-email.dto';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';

const user = { id: 'user_1' } as AuthUser;

const dto: SendEmailDto = {
  from: 'contact@boutique-awa.gn',
  to: 'client@exemple.gn',
  subject: 'Votre commande est prête',
  html: '<p>Bonjour</p>',
};

/** Corps d'erreur NestJS typé, pour éviter l'accès `any` sur `response.body`. */
function messageOf(response: { body: unknown }): string | undefined {
  return (response.body as { message?: string }).message;
}

describe('EmailsController', () => {
  let controller: EmailsController;

  const emailsService = { send: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    emailsService.send.mockResolvedValue({
      id: 'e_0123456789ab',
      status: 'queued',
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmailsController],
      providers: [{ provide: EmailsService, useValue: emailsService }],
    })
      .overrideGuard(ApiKeyAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(EmailVerifiedGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(EmailsController);
  });

  it('is guarded by the API key guard then the confirmation one, never by the session one', () => {
    const guards: unknown = Reflect.getMetadata(
      GUARDS_METADATA,
      EmailsController,
    );

    // L'ordre compte : on authentifie avant de juger de la confirmation.
    expect(guards).toEqual([ApiKeyAuthGuard, EmailVerifiedGuard]);
  });

  it('answers 202 Accepted — the send is only queued', () => {
    const handler = Object.getOwnPropertyDescriptor(
      EmailsController.prototype,
      'send',
    )?.value as (...args: unknown[]) => unknown;
    const httpCode: unknown = Reflect.getMetadata(HTTP_CODE_METADATA, handler);

    expect(httpCode).toBe(HttpStatus.ACCEPTED);
  });

  it('delegates to the service with the authenticated user id', async () => {
    await expect(controller.send(user, dto)).resolves.toEqual({
      id: 'e_0123456789ab',
      status: 'queued',
    });

    expect(emailsService.send).toHaveBeenCalledWith('user_1', dto);
  });
});

/**
 * Preuve, via une vraie application Nest et de vraies requêtes HTTP, que le
 * mode bac à sable (B20) ne contourne à aucun moment l'exigence de
 * confirmation d'adresse : `EmailVerifiedGuard` est la vraie classe, montée
 * par le vrai `@UseGuards` du contrôleur, quelle que soit l'adresse
 * destinataire envoyée. Le comportement lui-même (403 sur un compte non
 * confirmé) est déjà couvert par `auth/email-verified.guard.spec.ts` ; ce
 * bloc prouve seulement qu'`EmailsService.send` — donc le contrôle du
 * destinataire de test qu'il contient — n'est **jamais atteint** pour un
 * compte non confirmé, même s'il vise l'adresse de test. Réutilisation du
 * garde de la vague 8, pas de réimplémentation.
 */
describe('EmailsController — sécurité (garde réel, bout en bout)', () => {
  let app: INestApplication<App>;
  const apiKeyAuthGuard = { canActivate: jest.fn() };
  const emailsService = { send: jest.fn() };

  const sandboxDto: SendEmailDto = {
    from: 'Zendou <essai@mail.kingreys.fr>',
    to: 'aissatou@exemple.gn',
    subject: 'Test depuis le bac à sable',
    html: '<p>Bonjour</p>',
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmailsController],
      providers: [
        EmailVerifiedGuard,
        { provide: EmailsService, useValue: emailsService },
      ],
    })
      // `ApiKeyAuthGuard` construit `PrismaService` par injection : on ne
      // double que sa sortie, comme le premier bloc de ce fichier.
      // `EmailVerifiedGuard`, lui, n'a aucune dépendance — c'est la vraie
      // classe, inchangée, qui juge ici.
      .overrideGuard(ApiKeyAuthGuard)
      .useValue(apiKeyAuthGuard)
      .compile();

    app = module.createNestApplication<INestApplication<App>>();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    emailsService.send.mockResolvedValue({
      id: 'e_0123456789ab',
      status: 'queued',
    });
  });

  it('répond 403 pour un compte non confirmé, même en visant l’adresse de test', async () => {
    apiKeyAuthGuard.canActivate.mockImplementation(
      (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
        req.user = { ...user, emailVerifiedAt: null };
        return true;
      },
    );

    const response = await request(app.getHttpServer())
      .post('/emails')
      .send(sandboxDto);

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
    expect(messageOf(response)).toBe(EMAIL_NOT_VERIFIED_MESSAGE);
    expect(emailsService.send).not.toHaveBeenCalled();
  });

  it('laisse passer un compte confirmé jusqu’au service, adresse de test comprise', async () => {
    apiKeyAuthGuard.canActivate.mockImplementation(
      (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
        req.user = { ...user, emailVerifiedAt: new Date('2026-08-01') };
        return true;
      },
    );

    const response = await request(app.getHttpServer())
      .post('/emails')
      .send(sandboxDto);

    expect(response.status).toBe(HttpStatus.ACCEPTED);
    expect(emailsService.send).toHaveBeenCalledWith('user_1', sandboxDto);
  });
});

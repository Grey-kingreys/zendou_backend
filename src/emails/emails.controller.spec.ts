import { Test, TestingModule } from '@nestjs/testing';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { HttpStatus } from '@nestjs/common';
import { ApiKeyAuthGuard } from '../api-keys';
import type { AuthUser } from '../auth';
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
      .compile();

    controller = module.get(EmailsController);
  });

  it('is guarded by the API key guard, never by the session one', () => {
    const guards: unknown = Reflect.getMetadata(
      GUARDS_METADATA,
      EmailsController,
    );

    expect(guards).toEqual([ApiKeyAuthGuard]);
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

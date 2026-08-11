import { Test, TestingModule } from '@nestjs/testing';
import { EmailStatus, UserRole, UserStatus } from '@prisma/client';
import { SessionAuthGuard } from '../auth';
import type { AuthUser } from '../auth';
import { EmailsLogController } from './emails-log.controller';
import { EmailsLogService } from './emails-log.service';
import type { EmailDetail, PaginatedEmails } from './emails-log.types';

const authUser: AuthUser = {
  id: 'user_1',
  email: 'aissatou@example.com',
  name: 'Aïssatou Diallo',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('EmailsLogController', () => {
  let controller: EmailsLogController;

  const emailsLogService = { list: jest.fn(), detail: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmailsLogController],
      providers: [{ provide: EmailsLogService, useValue: emailsLogService }],
    })
      // Le guard est couvert par session-auth.guard.spec.ts.
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<EmailsLogController>(EmailsLogController);
  });

  it('delegates the list to the service, scoped to the current user', async () => {
    const paginated: PaginatedEmails = {
      items: [],
      total: 0,
      page: 1,
      limit: 25,
      totalPages: 0,
    };
    emailsLogService.list.mockResolvedValue(paginated);

    const result = await controller.list(
      { status: EmailStatus.SENT },
      authUser,
    );

    expect(emailsLogService.list).toHaveBeenCalledWith('user_1', {
      status: EmailStatus.SENT,
    });
    expect(result).toEqual(paginated);
  });

  it('delegates the detail lookup to the service, scoped to the current user', async () => {
    const detail: EmailDetail = {
      publicId: 'pub_1',
      fromAddress: 'contact@zendou.gn',
      toAddress: 'aissatou@example.com',
      subject: 'Bienvenue',
      status: EmailStatus.SENT,
      errorMessage: null,
      sesMessageId: 'ses_1',
      queuedAt: new Date('2026-01-01T00:00:00.000Z'),
      sentAt: null,
      deliveredAt: null,
      lastEventAt: null,
    };
    emailsLogService.detail.mockResolvedValue(detail);

    const result = await controller.detail('pub_1', authUser);

    expect(emailsLogService.detail).toHaveBeenCalledWith('user_1', 'pub_1');
    expect(result).toEqual(detail);
  });
});

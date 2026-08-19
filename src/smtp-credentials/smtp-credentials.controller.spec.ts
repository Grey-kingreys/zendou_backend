import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import { AuthUser, SessionAuthGuard } from '../auth';
import { SmtpCredentialsController } from './smtp-credentials.controller';
import { SmtpCredentialsService } from './smtp-credentials.service';

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

describe('SmtpCredentialsController', () => {
  let controller: SmtpCredentialsController;

  const smtpCredentialsService = {
    create: jest.fn(),
    findAllForUser: jest.fn(),
    revoke: jest.fn(),
    purge: jest.fn(),
    rotate: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SmtpCredentialsController],
      providers: [
        { provide: SmtpCredentialsService, useValue: smtpCredentialsService },
      ],
    })
      // Le guard est couvert par session-auth.guard.spec.ts.
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<SmtpCredentialsController>(
      SmtpCredentialsController,
    );
  });

  it('scopes creation to the current user', async () => {
    smtpCredentialsService.create.mockResolvedValue({
      id: 'smtp_1',
      name: 'WordPress boutique',
      username: 'zdu_aaaaaaaaaaaaaaaa',
      prefix: 'zd_smtp_abcd',
      password: 'zd_smtp_abcd1234',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await controller.create(authUser, { name: 'WordPress boutique' });

    expect(smtpCredentialsService.create).toHaveBeenCalledWith('user_1', {
      name: 'WordPress boutique',
    });
  });

  it('scopes the list to the current user', async () => {
    smtpCredentialsService.findAllForUser.mockResolvedValue([]);

    await controller.findAll(authUser);

    expect(smtpCredentialsService.findAllForUser).toHaveBeenCalledWith(
      'user_1',
    );
  });

  it('scopes revocation to the current user', async () => {
    smtpCredentialsService.revoke.mockResolvedValue(undefined);

    await controller.revoke(authUser, 'smtp_1');

    expect(smtpCredentialsService.revoke).toHaveBeenCalledWith(
      'user_1',
      'smtp_1',
    );
  });

  it('scopes deletion to the current user', async () => {
    smtpCredentialsService.purge.mockResolvedValue(undefined);

    await controller.purge(authUser, 'smtp_1');

    expect(smtpCredentialsService.purge).toHaveBeenCalledWith(
      'user_1',
      'smtp_1',
    );
  });

  it('scopes rotation to the current user', async () => {
    smtpCredentialsService.rotate.mockResolvedValue({
      id: 'smtp_1',
      name: 'WordPress boutique',
      username: 'zdu_aaaaaaaaaaaaaaaa',
      prefix: 'zd_smtp_wxyz',
      password: 'zd_smtp_wxyz5678',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      rotatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    await controller.rotate(authUser, 'smtp_1');

    expect(smtpCredentialsService.rotate).toHaveBeenCalledWith(
      'user_1',
      'smtp_1',
    );
  });
});

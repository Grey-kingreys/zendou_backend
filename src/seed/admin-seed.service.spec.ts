import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma, UserRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSeedService } from './admin-seed.service';

interface CreateArgs {
  data: {
    email: string;
    passwordHash: string;
    name: string;
    role: UserRole;
    status: UserStatus;
  };
}

interface UpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}

describe('AdminSeedService', () => {
  let service: AdminSeedService;
  let capturedCreateArgs: CreateArgs | undefined;
  let capturedUpdateArgs: UpdateArgs | undefined;

  const findUnique = jest.fn();
  const create = jest.fn((args: CreateArgs) => {
    capturedCreateArgs = args;
    return Promise.resolve({ id: 'admin_1' });
  });
  const update = jest.fn((args: UpdateArgs) => {
    capturedUpdateArgs = args;
    return Promise.resolve({ id: args.where.id });
  });

  const config: Record<string, string | undefined> = {};
  const configService = {
    get: jest.fn((key: string) => config[key]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedCreateArgs = undefined;
    capturedUpdateArgs = undefined;
    for (const key of Object.keys(config)) delete config[key];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminSeedService,
        {
          provide: PrismaService,
          useValue: { user: { findUnique, create, update } },
        },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<AdminSeedService>(AdminSeedService);
  });

  it('does nothing when ADMIN_EMAIL/ADMIN_PASSWORD are absent', async () => {
    await service.onApplicationBootstrap();

    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('does nothing when only ADMIN_EMAIL is present', async () => {
    config.ADMIN_EMAIL = 'admin@zendou.gn';

    await service.onApplicationBootstrap();

    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  describe('when configured', () => {
    beforeEach(() => {
      config.ADMIN_EMAIL = ' Admin@Zendou.gn ';
      config.ADMIN_PASSWORD = 'motdepasse-admin-solide';
      config.ADMIN_NAME = 'Souleymane';
    });

    it('creates the admin account with an argon2 hash and ADMIN/ACTIVE when absent', async () => {
      findUnique.mockResolvedValue(null);

      await service.onApplicationBootstrap();

      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'admin@zendou.gn' } }),
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(capturedCreateArgs).toBeDefined();
      const { data } = capturedCreateArgs!;

      expect(data.email).toBe('admin@zendou.gn');
      expect(data.name).toBe('Souleymane');
      expect(data.role).toBe(UserRole.ADMIN);
      expect(data.status).toBe(UserStatus.ACTIVE);
      expect(data.passwordHash).not.toBe('motdepasse-admin-solide');
      expect(data.passwordHash.startsWith('$argon2id$')).toBe(true);
      await expect(
        argon2.verify(data.passwordHash, 'motdepasse-admin-solide'),
      ).resolves.toBe(true);

      expect(update).not.toHaveBeenCalled();
    }, 15000);

    it('does not write anything when an ADMIN account already exists', async () => {
      findUnique.mockResolvedValue({ id: 'admin_1', role: UserRole.ADMIN });

      await service.onApplicationBootstrap();

      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('promotes an existing CUSTOMER account to ADMIN without touching the password', async () => {
      findUnique.mockResolvedValue({
        id: 'user_existing',
        role: UserRole.CUSTOMER,
      });

      await service.onApplicationBootstrap();

      expect(create).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith({
        where: { id: 'user_existing' },
        data: { role: UserRole.ADMIN },
      });
      expect(capturedUpdateArgs).toBeDefined();
      expect(capturedUpdateArgs!.data).not.toHaveProperty('passwordHash');
    });

    it('treats a P2002 unique violation on create as already-created (no throw)', async () => {
      findUnique.mockResolvedValue(null);
      create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    }, 15000);

    it('swallows an unexpected error and never propagates it (boot must continue)', async () => {
      findUnique.mockRejectedValue(new Error('database is on fire'));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });
});

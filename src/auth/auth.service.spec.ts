import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Prisma, UserRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { AuthUser } from './auth.types';
import {
  EMAIL_ALREADY_USED_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
} from './auth.constants';
import { SessionService } from './session.service';

interface CreateArgs {
  data: {
    email: string;
    passwordHash: string;
    name: string;
    company: string | null;
    declaredUsage: string | null;
  };
}

const authUser: AuthUser = {
  id: 'user_1',
  email: 'aissatou@example.com',
  name: 'Aïssatou Diallo',
  company: 'Kingreys',
  declaredUsage: 'Notifications transactionnelles',
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('AuthService', () => {
  let service: AuthService;
  let capturedCreateArgs: CreateArgs | undefined;

  const findUnique = jest.fn();
  const create = jest.fn((args: CreateArgs) => {
    capturedCreateArgs = args;
    return Promise.resolve(authUser);
  });
  const sessionService = {
    create: jest.fn(),
    resolve: jest.fn(),
    destroy: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedCreateArgs = undefined;
    sessionService.create.mockResolvedValue('session-token');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: { user: { findUnique, create } } },
        { provide: SessionService, useValue: sessionService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('register', () => {
    it('hashes the password with argon2id and never stores it in clear', async () => {
      findUnique.mockResolvedValue(null);

      const result = await service.register({
        email: 'Aissatou@Example.com ',
        password: 'motdepasse-solide',
        name: 'Aïssatou Diallo',
        company: 'Kingreys',
        declaredUsage: 'Notifications transactionnelles',
      });

      expect(capturedCreateArgs).toBeDefined();
      const stored = capturedCreateArgs!.data;

      expect(stored.passwordHash).not.toBe('motdepasse-solide');
      expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
      await expect(
        argon2.verify(stored.passwordHash, 'motdepasse-solide'),
      ).resolves.toBe(true);

      // l'email est normalisé avant insertion
      expect(stored.email).toBe('aissatou@example.com');

      expect(sessionService.create).toHaveBeenCalledWith('user_1');
      expect(result).toEqual({ user: authUser, token: 'session-token' });
      expect(result.user).not.toHaveProperty('passwordHash');
    }, 15000);

    it('rejects a duplicate email with a 409 and does not create the user', async () => {
      findUnique.mockResolvedValue({ id: 'user_existing' });

      await expect(
        service.register({
          email: 'aissatou@example.com',
          password: 'motdepasse-solide',
          name: 'Aïssatou Diallo',
        }),
      ).rejects.toMatchObject(
        new ConflictException(EMAIL_ALREADY_USED_MESSAGE),
      );

      expect(create).not.toHaveBeenCalled();
      expect(sessionService.create).not.toHaveBeenCalled();
    });

    it('maps a Prisma P2002 unique violation to a 409 (concurrent signups)', async () => {
      findUnique.mockResolvedValue(null);
      create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      await expect(
        service.register({
          email: 'aissatou@example.com',
          password: 'motdepasse-solide',
          name: 'Aïssatou Diallo',
        }),
      ).rejects.toMatchObject(
        new ConflictException(EMAIL_ALREADY_USED_MESSAGE),
      );

      expect(sessionService.create).not.toHaveBeenCalled();
    }, 15000);
  });

  describe('login', () => {
    it('opens a session when the password matches', async () => {
      const passwordHash = await argon2.hash('motdepasse-solide', {
        type: argon2.argon2id,
      });
      findUnique.mockResolvedValue({ ...authUser, passwordHash });

      const result = await service.login({
        email: ' Aissatou@Example.com',
        password: 'motdepasse-solide',
      });

      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'aissatou@example.com' } }),
      );
      expect(result.token).toBe('session-token');
      expect(result.user).toEqual(authUser);
      expect(result.user).not.toHaveProperty('passwordHash');
    }, 15000);

    it('rejects a wrong password with a generic 401', async () => {
      const passwordHash = await argon2.hash('motdepasse-solide', {
        type: argon2.argon2id,
      });
      findUnique.mockResolvedValue({ ...authUser, passwordHash });

      await expect(
        service.login({
          email: 'aissatou@example.com',
          password: 'mauvais-mot-de-passe',
        }),
      ).rejects.toMatchObject(
        new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE),
      );

      expect(sessionService.create).not.toHaveBeenCalled();
    }, 15000);

    it('rejects an unknown email with the exact same 401 message (no oracle)', async () => {
      findUnique.mockResolvedValue(null);

      const unknownEmail = await service
        .login({ email: 'inconnu@example.com', password: 'motdepasse-solide' })
        .catch((error: UnauthorizedException) => error);

      const passwordHash = await argon2.hash('motdepasse-solide', {
        type: argon2.argon2id,
      });
      findUnique.mockResolvedValue({ ...authUser, passwordHash });

      const wrongPassword = await service
        .login({ email: 'aissatou@example.com', password: 'mauvais' })
        .catch((error: UnauthorizedException) => error);

      expect(unknownEmail).toBeInstanceOf(UnauthorizedException);
      expect(wrongPassword).toBeInstanceOf(UnauthorizedException);
      expect((unknownEmail as UnauthorizedException).getStatus()).toBe(401);
      expect((unknownEmail as UnauthorizedException).getResponse()).toEqual(
        (wrongPassword as UnauthorizedException).getResponse(),
      );
      expect(sessionService.create).not.toHaveBeenCalled();
    }, 15000);
  });
});

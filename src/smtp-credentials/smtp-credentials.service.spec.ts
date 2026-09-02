import { createHash, createHmac } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretHashingService } from '../api-keys';
import { PrismaService } from '../prisma/prisma.service';
import {
  SMTP_CREDENTIAL_NOT_FOUND_MESSAGE,
  SMTP_CREDENTIAL_NOT_REVOKED_MESSAGE,
  SMTP_CREDENTIAL_ROTATE_REVOKED_MESSAGE,
} from './smtp-credentials.constants';
import { SmtpCredentialsService } from './smtp-credentials.service';

interface CreateArgs {
  data: {
    userId: string;
    name: string;
    username: string;
    prefix: string;
    secretHash: string;
  };
}

interface FindManyArgs {
  where: { userId: string };
  select: Record<string, boolean>;
  orderBy: { createdAt: 'desc' };
}

interface UpdateArgs {
  where: { id: string };
  data: {
    revokedAt?: Date;
    prefix?: string;
    secretHash?: string;
    rotatedAt?: Date;
  };
}

interface DeleteArgs {
  where: { id: string };
}

const listedCredential = {
  id: 'smtp_1',
  name: 'WordPress boutique',
  username: 'zdu_aaaaaaaaaaaaaaaa',
  prefix: 'zd_smtp_abcd',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastUsedAt: null,
  revokedAt: null,
};

describe('SmtpCredentialsService', () => {
  let service: SmtpCredentialsService;
  let capturedCreateArgs: CreateArgs | undefined;
  let capturedFindManyArgs: FindManyArgs | undefined;
  let capturedUpdateArgs: UpdateArgs | undefined;
  let capturedDeleteArgs: DeleteArgs | undefined;

  const findUnique = jest.fn();
  const findMany = jest.fn((args: FindManyArgs) => {
    capturedFindManyArgs = args;
    return Promise.resolve([listedCredential]);
  });
  const update = jest.fn((args: UpdateArgs) => {
    capturedUpdateArgs = args;
    return Promise.resolve();
  });
  const create = jest.fn((args: CreateArgs) => {
    capturedCreateArgs = args;
    return Promise.resolve({
      id: 'smtp_1',
      name: args.data.name,
      username: args.data.username,
      prefix: args.data.prefix,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });
  const deleteFn = jest.fn((args: DeleteArgs) => {
    capturedDeleteArgs = args;
    return Promise.resolve();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedCreateArgs = undefined;
    capturedFindManyArgs = undefined;
    capturedUpdateArgs = undefined;
    capturedDeleteArgs = undefined;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmtpCredentialsService,
        // Vrai service de hachage, sans poivre configuré : comportement
        // historique (SHA-256), inchangé par E3.
        SecretHashingService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PrismaService,
          useValue: {
            smtpCredential: {
              findUnique,
              findMany,
              update,
              create,
              delete: deleteFn,
            },
          },
        },
      ],
    }).compile();

    service = module.get<SmtpCredentialsService>(SmtpCredentialsService);
  });

  describe('create', () => {
    it('returns the full password exactly once, distinct from the stored hash', async () => {
      const result = await service.create('user_1', {
        name: '  WordPress boutique  ',
      });

      expect(result.password.startsWith('zd_smtp_')).toBe(true);
      expect(capturedCreateArgs).toBeDefined();
      const stored = capturedCreateArgs!.data;

      // Le nom est trimé avant insertion.
      expect(stored.name).toBe('WordPress boutique');
      expect(stored.userId).toBe('user_1');

      // Nom d'utilisateur opaque et généré, jamais l'adresse email du compte.
      expect(stored.username.startsWith('zdu_')).toBe(true);
      expect(stored.username).toMatch(/^zdu_[0-9a-f]{16}$/);

      // Le hash stocké n'est jamais le mot de passe en clair, et diffère du
      // mot de passe renvoyé.
      expect(stored.secretHash).not.toBe(result.password);
      expect(stored.secretHash).toHaveLength(64); // sha256 hex
      expect(stored.prefix).toBe(result.password.slice(0, 12));

      expect(result).toEqual({
        id: 'smtp_1',
        name: 'WordPress boutique',
        username: stored.username,
        prefix: stored.prefix,
        password: result.password,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    });
  });

  describe('findAllForUser', () => {
    it('scopes the list to the given user and never selects secretHash', async () => {
      const result = await service.findAllForUser('user_1');

      expect(capturedFindManyArgs).toBeDefined();
      expect(capturedFindManyArgs!.where).toEqual({ userId: 'user_1' });
      expect(capturedFindManyArgs!.select).not.toHaveProperty('secretHash');
      expect(result).toEqual([listedCredential]);
    });
  });

  describe('revoke', () => {
    it('throws 404 when the credential does not exist', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.revoke('user_1', 'smtp_missing'),
      ).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('throws 404 when the credential belongs to another user', async () => {
      findUnique.mockResolvedValue({
        id: 'smtp_1',
        userId: 'user_2',
        revokedAt: null,
      });

      await expect(service.revoke('user_1', 'smtp_1')).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('sets revokedAt on an active credential', async () => {
      findUnique.mockResolvedValue({
        id: 'smtp_1',
        userId: 'user_1',
        revokedAt: null,
      });

      await service.revoke('user_1', 'smtp_1');

      expect(capturedUpdateArgs).toBeDefined();
      expect(capturedUpdateArgs!.where).toEqual({ id: 'smtp_1' });
      expect(capturedUpdateArgs!.data.revokedAt).toBeInstanceOf(Date);
    });

    it('is idempotent when the credential is already revoked', async () => {
      findUnique.mockResolvedValue({
        id: 'smtp_1',
        userId: 'user_1',
        revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await expect(service.revoke('user_1', 'smtp_1')).resolves.toBeUndefined();

      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('purge', () => {
    it('throws 404 when the credential does not exist', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.purge('user_1', 'smtp_missing'),
      ).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('throws 404 when the credential belongs to another user', async () => {
      findUnique.mockResolvedValue({
        id: 'smtp_1',
        userId: 'user_2',
        revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await expect(service.purge('user_1', 'smtp_1')).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('refuses to delete an active credential (409)', async () => {
      findUnique.mockResolvedValue({
        id: 'smtp_1',
        userId: 'user_1',
        revokedAt: null,
      });

      await expect(service.purge('user_1', 'smtp_1')).rejects.toMatchObject(
        new ConflictException(SMTP_CREDENTIAL_NOT_REVOKED_MESSAGE),
      );

      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('deletes a revoked credential', async () => {
      findUnique.mockResolvedValue({
        id: 'smtp_1',
        userId: 'user_1',
        revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await service.purge('user_1', 'smtp_1');

      expect(capturedDeleteArgs).toEqual({ where: { id: 'smtp_1' } });
    });
  });

  describe('rotate', () => {
    const rotatableCredential = {
      id: 'smtp_1',
      userId: 'user_1',
      name: 'WordPress boutique',
      username: 'zdu_aaaaaaaaaaaaaaaa',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      revokedAt: null,
    };

    it('throws 404 when the credential does not exist', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.rotate('user_1', 'smtp_missing'),
      ).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('throws 404 when the credential belongs to another user', async () => {
      findUnique.mockResolvedValue({
        ...rotatableCredential,
        userId: 'user_2',
      });

      await expect(service.rotate('user_1', 'smtp_1')).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('refuses to rotate a revoked credential', async () => {
      findUnique.mockResolvedValue({
        ...rotatableCredential,
        revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await expect(service.rotate('user_1', 'smtp_1')).rejects.toMatchObject(
        new ConflictException(SMTP_CREDENTIAL_ROTATE_REVOKED_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('regenerates prefix/secretHash in a single write, keeping id/name/username/createdAt — cutting the old secret immediately', async () => {
      findUnique.mockResolvedValue(rotatableCredential);

      const result = await service.rotate('user_1', 'smtp_1');

      // Une seule écriture (pas de second appel « désactive l'ancien puis
      // active le nouveau ») : la coupure est immédiate, sans grâce.
      expect(update).toHaveBeenCalledTimes(1);
      expect(capturedUpdateArgs).toBeDefined();
      expect(capturedUpdateArgs!.where).toEqual({ id: 'smtp_1' });
      expect(capturedUpdateArgs!.data.prefix).toBe(result.prefix);
      expect(capturedUpdateArgs!.data.secretHash).toBeDefined();
      expect(capturedUpdateArgs!.data.rotatedAt).toBeInstanceOf(Date);

      // Identité, nom, nom d'utilisateur et date de création inchangés.
      expect(result.id).toBe('smtp_1');
      expect(result.name).toBe('WordPress boutique');
      expect(result.username).toBe('zdu_aaaaaaaaaaaaaaaa');
      expect(result.createdAt).toEqual(rotatableCredential.createdAt);

      // Nouveau secret renvoyé une seule fois, distinct du hash stocké.
      expect(result.password.startsWith('zd_smtp_')).toBe(true);
      expect(capturedUpdateArgs!.data.secretHash).not.toBe(result.password);
      expect(result.rotatedAt).toBeInstanceOf(Date);
    });
  });
});

/** E3 - la colonne `secretHash` reçoit l'empreinte poivrée, comme `keyHash`. */
describe('SmtpCredentialsService - empreinte poivrée persistée (E3)', () => {
  const PEPPER = 'p'.repeat(64);

  let service: SmtpCredentialsService;
  let captured: { data: { secretHash: string; prefix: string } } | undefined;

  const create = jest.fn(
    (args: {
      data: { secretHash: string; prefix: string; username: string };
    }) => {
      captured = args;
      return Promise.resolve({
        id: 'smtp_1',
        name: 'WordPress boutique',
        username: args.data.username,
        prefix: args.data.prefix,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    },
  );

  beforeEach(async () => {
    jest.clearAllMocks();
    captured = undefined;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmtpCredentialsService,
        SecretHashingService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'API_KEY_PEPPER' ? PEPPER : undefined,
          },
        },
        { provide: PrismaService, useValue: { smtpCredential: { create } } },
      ],
    }).compile();

    service = module.get<SmtpCredentialsService>(SmtpCredentialsService);
  });

  it('stocke le HMAC poivré du mot de passe, jamais son SHA-256 nu', async () => {
    const result = await service.create('user_1', { name: 'WordPress' });

    expect(captured?.data.secretHash).toBe(
      createHmac('sha256', PEPPER).update(result.password).digest('hex'),
    );
    expect(captured?.data.secretHash).not.toBe(
      createHash('sha256').update(result.password).digest('hex'),
    );
  });

  it('rend un mot de passe zd_smtp_ + 43 caractères, préfixe affiché de 12', async () => {
    const result = await service.create('user_1', { name: 'WordPress' });

    expect(result.password).toMatch(/^zd_smtp_[A-Za-z0-9]{43}$/);
    expect(result.prefix).toBe(result.password.slice(0, 12));
    expect(result.prefix).toHaveLength(12);
  });
});

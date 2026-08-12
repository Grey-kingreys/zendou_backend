import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  API_KEY_NOT_FOUND_MESSAGE,
  API_KEY_NOT_REVOKED_MESSAGE,
  API_KEY_ROTATE_REVOKED_MESSAGE,
} from './api-keys.constants';
import { ApiKeysService } from './api-keys.service';

interface CreateArgs {
  data: { userId: string; name: string; prefix: string; keyHash: string };
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
    keyHash?: string;
    rotatedAt?: Date;
  };
}

interface DeleteArgs {
  where: { id: string };
}

const listedKey = {
  id: 'key_1',
  name: 'Prod',
  prefix: 'zd_live_abcd',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastUsedAt: null,
  revokedAt: null,
};

describe('ApiKeysService', () => {
  let service: ApiKeysService;
  let capturedCreateArgs: CreateArgs | undefined;
  let capturedFindManyArgs: FindManyArgs | undefined;
  let capturedUpdateArgs: UpdateArgs | undefined;
  let capturedDeleteArgs: DeleteArgs | undefined;

  const findUnique = jest.fn();
  const findMany = jest.fn((args: FindManyArgs) => {
    capturedFindManyArgs = args;
    return Promise.resolve([listedKey]);
  });
  const update = jest.fn((args: UpdateArgs) => {
    capturedUpdateArgs = args;
    return Promise.resolve();
  });
  const create = jest.fn((args: CreateArgs) => {
    capturedCreateArgs = args;
    return Promise.resolve({
      id: 'key_1',
      name: args.data.name,
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
        ApiKeysService,
        {
          provide: PrismaService,
          useValue: {
            apiKey: { findUnique, findMany, update, create, delete: deleteFn },
          },
        },
      ],
    }).compile();

    service = module.get<ApiKeysService>(ApiKeysService);
  });

  describe('create', () => {
    it('returns the full key exactly once, distinct from the stored hash', async () => {
      const result = await service.create('user_1', { name: '  Prod  ' });

      expect(result.key.startsWith('zd_live_')).toBe(true);
      expect(capturedCreateArgs).toBeDefined();
      const stored = capturedCreateArgs!.data;

      // Le nom est trimé avant insertion.
      expect(stored.name).toBe('Prod');
      expect(stored.userId).toBe('user_1');

      // Le hash stocké n'est jamais la clé en clair, et diffère de la clé renvoyée.
      expect(stored.keyHash).not.toBe(result.key);
      expect(stored.keyHash).toHaveLength(64); // sha256 hex
      expect(stored.prefix).toBe(result.key.slice(0, 12));

      expect(result).toEqual({
        id: 'key_1',
        name: 'Prod',
        prefix: stored.prefix,
        key: result.key,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    });
  });

  describe('findAllForUser', () => {
    it('scopes the list to the given user and never selects keyHash', async () => {
      const result = await service.findAllForUser('user_1');

      expect(capturedFindManyArgs).toBeDefined();
      expect(capturedFindManyArgs!.where).toEqual({ userId: 'user_1' });
      expect(capturedFindManyArgs!.select).not.toHaveProperty('keyHash');
      expect(result).toEqual([listedKey]);
    });
  });

  describe('revoke', () => {
    it('throws 404 when the key does not exist', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.revoke('user_1', 'key_missing'),
      ).rejects.toMatchObject(new NotFoundException(API_KEY_NOT_FOUND_MESSAGE));

      expect(update).not.toHaveBeenCalled();
    });

    it('throws 404 when the key belongs to another user', async () => {
      findUnique.mockResolvedValue({
        id: 'key_1',
        userId: 'user_2',
        revokedAt: null,
      });

      await expect(service.revoke('user_1', 'key_1')).rejects.toMatchObject(
        new NotFoundException(API_KEY_NOT_FOUND_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('sets revokedAt on an active key', async () => {
      findUnique.mockResolvedValue({
        id: 'key_1',
        userId: 'user_1',
        revokedAt: null,
      });

      await service.revoke('user_1', 'key_1');

      expect(capturedUpdateArgs).toBeDefined();
      expect(capturedUpdateArgs!.where).toEqual({ id: 'key_1' });
      expect(capturedUpdateArgs!.data.revokedAt).toBeInstanceOf(Date);
    });

    it('is idempotent when the key is already revoked', async () => {
      findUnique.mockResolvedValue({
        id: 'key_1',
        userId: 'user_1',
        revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await expect(service.revoke('user_1', 'key_1')).resolves.toBeUndefined();

      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('purge', () => {
    it('throws 404 when the key does not exist', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.purge('user_1', 'key_missing'),
      ).rejects.toMatchObject(new NotFoundException(API_KEY_NOT_FOUND_MESSAGE));

      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('throws 404 when the key belongs to another user', async () => {
      findUnique.mockResolvedValue({
        id: 'key_1',
        userId: 'user_2',
        revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await expect(service.purge('user_1', 'key_1')).rejects.toMatchObject(
        new NotFoundException(API_KEY_NOT_FOUND_MESSAGE),
      );

      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('refuses to delete an active key', async () => {
      findUnique.mockResolvedValue({
        id: 'key_1',
        userId: 'user_1',
        revokedAt: null,
      });

      await expect(service.purge('user_1', 'key_1')).rejects.toMatchObject(
        new ConflictException(API_KEY_NOT_REVOKED_MESSAGE),
      );

      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('deletes a revoked key', async () => {
      findUnique.mockResolvedValue({
        id: 'key_1',
        userId: 'user_1',
        revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await service.purge('user_1', 'key_1');

      expect(capturedDeleteArgs).toEqual({ where: { id: 'key_1' } });
    });
  });

  describe('rotate', () => {
    const rotatableKey = {
      id: 'key_1',
      userId: 'user_1',
      name: 'Prod',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      revokedAt: null,
    };

    it('throws 404 when the key does not exist', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.rotate('user_1', 'key_missing'),
      ).rejects.toMatchObject(new NotFoundException(API_KEY_NOT_FOUND_MESSAGE));

      expect(update).not.toHaveBeenCalled();
    });

    it('throws 404 when the key belongs to another user', async () => {
      findUnique.mockResolvedValue({ ...rotatableKey, userId: 'user_2' });

      await expect(service.rotate('user_1', 'key_1')).rejects.toMatchObject(
        new NotFoundException(API_KEY_NOT_FOUND_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('refuses to rotate a revoked key', async () => {
      findUnique.mockResolvedValue({
        ...rotatableKey,
        revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await expect(service.rotate('user_1', 'key_1')).rejects.toMatchObject(
        new ConflictException(API_KEY_ROTATE_REVOKED_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('regenerates prefix/keyHash while keeping id, name and createdAt', async () => {
      findUnique.mockResolvedValue(rotatableKey);

      const result = await service.rotate('user_1', 'key_1');

      expect(capturedUpdateArgs).toBeDefined();
      expect(capturedUpdateArgs!.where).toEqual({ id: 'key_1' });
      expect(capturedUpdateArgs!.data.prefix).toBe(result.prefix);
      expect(capturedUpdateArgs!.data.keyHash).toBeDefined();
      expect(capturedUpdateArgs!.data.rotatedAt).toBeInstanceOf(Date);

      // Identité, nom et date de création inchangés.
      expect(result.id).toBe('key_1');
      expect(result.name).toBe('Prod');
      expect(result.createdAt).toEqual(rotatableKey.createdAt);

      // Nouveau secret renvoyé une seule fois, distinct du hash stocké.
      expect(result.key.startsWith('zd_live_')).toBe(true);
      expect(capturedUpdateArgs!.data.keyHash).not.toBe(result.key);
      expect(result.rotatedAt).toBeInstanceOf(Date);
    });
  });
});

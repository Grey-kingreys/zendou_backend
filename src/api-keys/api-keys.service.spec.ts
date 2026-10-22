import { createHash, createHmac } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  CREDENTIAL_DOMAINS_DUPLICATE_MESSAGE,
  CREDENTIAL_DOMAINS_INVALID_MESSAGE,
} from '../domains/credential-scope';
import { PrismaService } from '../prisma/prisma.service';
import {
  API_KEY_NOT_FOUND_MESSAGE,
  API_KEY_NOT_REVOKED_MESSAGE,
  API_KEY_ROTATE_REVOKED_MESSAGE,
} from './api-keys.constants';
import { ApiKeysService } from './api-keys.service';
import { SecretHashingService } from './secret-hashing.service';

interface CreateArgs {
  data: {
    userId: string;
    name: string;
    prefix: string;
    keyHash: string;
    domainScope: 'ALL' | 'SELECTED';
    canRead: boolean;
    domains: { create: { domainId: string }[] };
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
  domainScope: 'ALL' as 'ALL' | 'SELECTED',
  canRead: false,
  domains: [] as { domain: { id: string; name: string } }[],
};

describe('ApiKeysService', () => {
  let service: ApiKeysService;
  let capturedCreateArgs: CreateArgs | undefined;
  let capturedFindManyArgs: FindManyArgs | undefined;
  let capturedUpdateArgs: UpdateArgs | undefined;
  let capturedDeleteArgs: DeleteArgs | undefined;

  // E7 : le service ne charge plus une ligne par identifiant seul - il
  // demande à la base la ligne { id, userId }. Le double suit donc la même
  // méthode que le code de production.
  const findFirst = jest.fn();
  const domainCount = jest.fn();
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
      domainScope: args.data.domainScope,
      canRead: args.data.canRead,
      domains: args.data.domains.create.map((link) => ({
        domain: { id: link.domainId, name: `${link.domainId}.gn` },
      })),
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
    domainCount.mockResolvedValue(0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        // Vrai service de hachage, sans poivre configuré : le comportement
        // testé ici est donc l'historique (SHA-256), inchangé par E3.
        SecretHashingService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PrismaService,
          useValue: {
            apiKey: { findFirst, findMany, update, create, delete: deleteFn },
            domain: { count: domainCount },
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
        domainScope: 'ALL',
        canRead: false,
        domains: [],
      });
    });

    describe('permission de lecture', () => {
      it('crée une clé sans lecture quand canRead est absent', async () => {
        const result = await service.create('user_1', { name: 'Prod' });

        expect(capturedCreateArgs!.data.canRead).toBe(false);
        expect(result.canRead).toBe(false);
      });

      it('crée une clé sans lecture quand canRead est false', async () => {
        await service.create('user_1', { name: 'Prod', canRead: false });

        expect(capturedCreateArgs!.data.canRead).toBe(false);
      });

      it('crée une clé avec lecture quand canRead est true', async () => {
        const result = await service.create('user_1', {
          name: 'Prod',
          canRead: true,
        });

        expect(capturedCreateArgs!.data.canRead).toBe(true);
        expect(result.canRead).toBe(true);
      });
    });

    describe('portée par domaine (B27)', () => {
      it('crée une clé ALL, sans lien ni lecture de domaine, quand domainIds est absent', async () => {
        const result = await service.create('user_1', { name: 'Prod' });

        expect(capturedCreateArgs!.data.domainScope).toBe('ALL');
        expect(capturedCreateArgs!.data.domains).toEqual({ create: [] });
        expect(domainCount).not.toHaveBeenCalled();
        expect(result.domainScope).toBe('ALL');
        expect(result.domains).toEqual([]);
      });

      it('traite une liste vide comme ALL', async () => {
        await service.create('user_1', { name: 'Prod', domainIds: [] });

        expect(capturedCreateArgs!.data.domainScope).toBe('ALL');
        expect(capturedCreateArgs!.data.domains).toEqual({ create: [] });
      });

      it('crée une clé SELECTED liée aux domaines vérifiés du compte', async () => {
        domainCount.mockResolvedValue(2);

        const result = await service.create('user_1', {
          name: 'Prod',
          domainIds: ['dom_a', 'dom_b'],
        });

        // Seuls les domaines du compte ET vérifiés comptent.
        expect(domainCount).toHaveBeenCalledWith({
          where: {
            id: { in: ['dom_a', 'dom_b'] },
            userId: 'user_1',
            status: 'VERIFIED',
          },
        });
        expect(capturedCreateArgs!.data.domainScope).toBe('SELECTED');
        expect(capturedCreateArgs!.data.domains).toEqual({
          create: [{ domainId: 'dom_a' }, { domainId: 'dom_b' }],
        });
        expect(result.domainScope).toBe('SELECTED');
        expect(result.domains).toEqual([
          { id: 'dom_a', name: 'dom_a.gn' },
          { id: 'dom_b', name: 'dom_b.gn' },
        ]);
      });

      it("refuse en 400 un domaine d'un autre compte, inexistant ou non vérifié", async () => {
        // La base ne rend que 1 des 2 domaines : l'autre n'appartient pas au
        // compte, n'existe pas ou n'est pas vérifié.
        domainCount.mockResolvedValue(1);

        await expect(
          service.create('user_1', {
            name: 'Prod',
            domainIds: ['dom_a', 'dom_autre'],
          }),
        ).rejects.toMatchObject(
          new BadRequestException(CREDENTIAL_DOMAINS_INVALID_MESSAGE),
        );

        expect(create).not.toHaveBeenCalled();
      });

      it("traduit en 400 un domaine supprimé entre le contrôle et l'écriture (P2003)", async () => {
        domainCount.mockResolvedValue(1);
        create.mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('fk', {
            code: 'P2003',
            clientVersion: 'test',
          }),
        );

        await expect(
          service.create('user_1', { name: 'Prod', domainIds: ['dom_a'] }),
        ).rejects.toMatchObject(
          new BadRequestException(CREDENTIAL_DOMAINS_INVALID_MESSAGE),
        );
      });

      it('laisse passer toute autre erreur de base telle quelle', async () => {
        create.mockRejectedValueOnce(new Error('base indisponible'));

        await expect(
          service.create('user_1', { name: 'Prod' }),
        ).rejects.toThrow('base indisponible');
      });

      it('refuse en 400 un domaine sélectionné deux fois', async () => {
        domainCount.mockResolvedValue(1);

        await expect(
          service.create('user_1', {
            name: 'Prod',
            domainIds: ['dom_a', 'dom_a'],
          }),
        ).rejects.toMatchObject(
          new BadRequestException(CREDENTIAL_DOMAINS_DUPLICATE_MESSAGE),
        );

        expect(create).not.toHaveBeenCalled();
      });
    });
  });

  describe('findAllForUser', () => {
    it('scopes the list to the given user and never selects keyHash', async () => {
      const result = await service.findAllForUser('user_1');

      expect(capturedFindManyArgs).toBeDefined();
      expect(capturedFindManyArgs!.where).toEqual({ userId: 'user_1' });
      expect(capturedFindManyArgs!.select).not.toHaveProperty('keyHash');
      expect(capturedFindManyArgs!.select).toHaveProperty('canRead', true);
      expect(result).toEqual([listedKey]);
    });

    it('expose la permission de lecture de chaque clé', async () => {
      findMany.mockResolvedValueOnce([
        { ...listedKey, canRead: true },
        { ...listedKey, id: 'key_2', canRead: false },
      ]);

      const result = await service.findAllForUser('user_1');

      expect(result.map((key) => key.canRead)).toEqual([true, false]);
    });

    it('expose la portée et les domaines liés (id + nom)', async () => {
      findMany.mockResolvedValueOnce([
        {
          ...listedKey,
          domainScope: 'SELECTED',
          domains: [{ domain: { id: 'dom_a', name: 'a.gn' } }],
        },
      ]);

      const result = await service.findAllForUser('user_1');

      expect(result[0].domainScope).toBe('SELECTED');
      expect(result[0].domains).toEqual([{ id: 'dom_a', name: 'a.gn' }]);
    });
  });

  describe('revoke', () => {
    it('throws 404 when the key does not exist', async () => {
      findFirst.mockResolvedValue(null);

      await expect(
        service.revoke('user_1', 'key_missing'),
      ).rejects.toMatchObject(new NotFoundException(API_KEY_NOT_FOUND_MESSAGE));

      expect(update).not.toHaveBeenCalled();
    });

    it('throws 404 when the key belongs to another user', async () => {
      // La base ne rend rien : le filtre { id, userId } ne matche pas.
      findFirst.mockResolvedValue(null);

      await expect(service.revoke('user_1', 'key_1')).rejects.toMatchObject(
        new NotFoundException(API_KEY_NOT_FOUND_MESSAGE),
      );

      // E7 : la propriété est demandée à la base, pas vérifiée après coup.
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 'key_1', userId: 'user_1' },
        select: { id: true, revokedAt: true },
      });
      expect(update).not.toHaveBeenCalled();
    });

    it('sets revokedAt on an active key', async () => {
      findFirst.mockResolvedValue({
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
      findFirst.mockResolvedValue({
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
      findFirst.mockResolvedValue(null);

      await expect(
        service.purge('user_1', 'key_missing'),
      ).rejects.toMatchObject(new NotFoundException(API_KEY_NOT_FOUND_MESSAGE));

      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('throws 404 when the key belongs to another user', async () => {
      findFirst.mockResolvedValue(null);

      await expect(service.purge('user_1', 'key_1')).rejects.toMatchObject(
        new NotFoundException(API_KEY_NOT_FOUND_MESSAGE),
      );

      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 'key_1', userId: 'user_1' },
        select: { id: true, revokedAt: true },
      });
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('refuses to delete an active key', async () => {
      findFirst.mockResolvedValue({
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
      findFirst.mockResolvedValue({
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
      findFirst.mockResolvedValue(null);

      await expect(
        service.rotate('user_1', 'key_missing'),
      ).rejects.toMatchObject(new NotFoundException(API_KEY_NOT_FOUND_MESSAGE));

      expect(update).not.toHaveBeenCalled();
    });

    it('throws 404 when the key belongs to another user', async () => {
      findFirst.mockResolvedValue(null);

      await expect(service.rotate('user_1', 'key_1')).rejects.toMatchObject(
        new NotFoundException(API_KEY_NOT_FOUND_MESSAGE),
      );

      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 'key_1', userId: 'user_1' },
        select: {
          id: true,
          name: true,
          createdAt: true,
          revokedAt: true,
        },
      });
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses to rotate a revoked key', async () => {
      findFirst.mockResolvedValue({
        ...rotatableKey,
        revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await expect(service.rotate('user_1', 'key_1')).rejects.toMatchObject(
        new ConflictException(API_KEY_ROTATE_REVOKED_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('regenerates prefix/keyHash while keeping id, name and createdAt', async () => {
      findFirst.mockResolvedValue(rotatableKey);

      const result = await service.rotate('user_1', 'key_1');

      expect(capturedUpdateArgs).toBeDefined();
      expect(capturedUpdateArgs!.where).toEqual({ id: 'key_1' });
      expect(capturedUpdateArgs!.data.prefix).toBe(result.prefix);
      expect(capturedUpdateArgs!.data.keyHash).toBeDefined();
      expect(capturedUpdateArgs!.data.rotatedAt).toBeInstanceOf(Date);

      // La portée par domaine (B27) et la permission de lecture sont
      // immuables : la rotation n'y touche pas.
      expect(Object.keys(capturedUpdateArgs!.data).sort()).toEqual([
        'keyHash',
        'prefix',
        'rotatedAt',
      ]);

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

/**
 * E3 - ce que la colonne `keyHash` reçoit réellement quand un poivre est
 * configuré. Le secret rendu au client, lui, ne change pas de forme.
 */
describe('ApiKeysService - empreinte poivrée persistée (E3)', () => {
  const PEPPER = 'p'.repeat(64);

  let service: ApiKeysService;
  let captured: { data: { keyHash: string; prefix: string } } | undefined;

  const create = jest.fn(
    (args: { data: { keyHash: string; prefix: string } }) => {
      captured = args;
      return Promise.resolve({
        id: 'key_1',
        name: 'Prod',
        prefix: args.data.prefix,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        domainScope: 'ALL',
        domains: [],
      });
    },
  );
  const update = jest.fn(
    (args: { data: { keyHash: string; prefix: string } }) => {
      captured = args;
      return Promise.resolve({});
    },
  );
  const findFirst = jest.fn();
  const findUnique = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    captured = undefined;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        SecretHashingService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'API_KEY_PEPPER' ? PEPPER : undefined,
          },
        },
        {
          provide: PrismaService,
          useValue: { apiKey: { create, update, findFirst, findUnique } },
        },
      ],
    }).compile();

    service = module.get<ApiKeysService>(ApiKeysService);
  });

  it('stocke le HMAC poivré de la clé, jamais son SHA-256 nu', async () => {
    const result = await service.create('user_1', { name: 'Prod' });

    expect(captured?.data.keyHash).toBe(
      createHmac('sha256', PEPPER).update(result.key).digest('hex'),
    );
    expect(captured?.data.keyHash).not.toBe(
      createHash('sha256').update(result.key).digest('hex'),
    );
  });

  it('stocke aussi l’empreinte poivrée à la rotation', async () => {
    findFirst.mockResolvedValue({
      id: 'key_1',
      name: 'Prod',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      revokedAt: null,
    });
    findFirst.mockResolvedValue({
      id: 'key_1',
      userId: 'user_1',
      name: 'Prod',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      revokedAt: null,
    });

    const result = await service.rotate('user_1', 'key_1');

    expect(captured?.data.keyHash).toBe(
      createHmac('sha256', PEPPER).update(result.key).digest('hex'),
    );
  });

  it('rend une clé au format zd_live_ + 43 caractères, préfixe affiché de 12', async () => {
    const result = await service.create('user_1', { name: 'Prod' });

    expect(result.key).toMatch(/^zd_live_[A-Za-z0-9]{43}$/);
    expect(result.prefix).toBe(result.key.slice(0, 12));
    expect(result.prefix).toHaveLength(12);
  });
});

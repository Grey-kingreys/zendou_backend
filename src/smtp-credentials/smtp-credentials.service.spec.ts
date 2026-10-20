import { createHash, createHmac } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { SecretHashingService } from '../api-keys';
import {
  CREDENTIAL_DOMAINS_DUPLICATE_MESSAGE,
  CREDENTIAL_DOMAINS_INVALID_MESSAGE,
} from '../domains/credential-scope';
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
    domainScope: 'ALL' | 'SELECTED';
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
  domainScope: 'ALL' as 'ALL' | 'SELECTED',
  domains: [] as { domain: { id: string; name: string } }[],
};

describe('SmtpCredentialsService', () => {
  let service: SmtpCredentialsService;
  let capturedCreateArgs: CreateArgs | undefined;
  let capturedFindManyArgs: FindManyArgs | undefined;
  let capturedUpdateArgs: UpdateArgs | undefined;
  let capturedDeleteArgs: DeleteArgs | undefined;

  // E7 : le service demande à la base la ligne { id, userId }, il ne charge
  // plus par identifiant seul pour comparer ensuite en JavaScript.
  const findFirst = jest.fn();
  const domainCount = jest.fn();
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
      domainScope: args.data.domainScope,
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
        SmtpCredentialsService,
        // Vrai service de hachage, sans poivre configuré : comportement
        // historique (SHA-256), inchangé par E3.
        SecretHashingService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PrismaService,
          useValue: {
            smtpCredential: {
              findFirst,
              findMany,
              update,
              create,
              delete: deleteFn,
            },
            domain: { count: domainCount },
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
        domainScope: 'ALL',
        domains: [],
      });
    });

    describe('portée par domaine (B27)', () => {
      it('crée un identifiant ALL, sans lien ni lecture de domaine, quand domainIds est absent', async () => {
        const result = await service.create('user_1', { name: 'WordPress' });

        expect(capturedCreateArgs!.data.domainScope).toBe('ALL');
        expect(capturedCreateArgs!.data.domains).toEqual({ create: [] });
        expect(domainCount).not.toHaveBeenCalled();
        expect(result.domainScope).toBe('ALL');
        expect(result.domains).toEqual([]);
      });

      it('traite une liste vide comme ALL', async () => {
        await service.create('user_1', { name: 'WordPress', domainIds: [] });

        expect(capturedCreateArgs!.data.domainScope).toBe('ALL');
        expect(capturedCreateArgs!.data.domains).toEqual({ create: [] });
      });

      it('crée un identifiant SELECTED lié aux domaines vérifiés du compte', async () => {
        domainCount.mockResolvedValue(2);

        const result = await service.create('user_1', {
          name: 'WordPress',
          domainIds: ['dom_a', 'dom_b'],
        });

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
        domainCount.mockResolvedValue(1);

        await expect(
          service.create('user_1', {
            name: 'WordPress',
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
          service.create('user_1', {
            name: 'WordPress',
            domainIds: ['dom_a'],
          }),
        ).rejects.toMatchObject(
          new BadRequestException(CREDENTIAL_DOMAINS_INVALID_MESSAGE),
        );
      });

      it('refuse en 400 un domaine sélectionné deux fois', async () => {
        domainCount.mockResolvedValue(1);

        await expect(
          service.create('user_1', {
            name: 'WordPress',
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
    it('scopes the list to the given user and never selects secretHash', async () => {
      const result = await service.findAllForUser('user_1');

      expect(capturedFindManyArgs).toBeDefined();
      expect(capturedFindManyArgs!.where).toEqual({ userId: 'user_1' });
      expect(capturedFindManyArgs!.select).not.toHaveProperty('secretHash');
      expect(result).toEqual([listedCredential]);
    });

    it('expose la portée et les domaines liés (id + nom)', async () => {
      findMany.mockResolvedValueOnce([
        {
          ...listedCredential,
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
    it('throws 404 when the credential does not exist', async () => {
      findFirst.mockResolvedValue(null);

      await expect(
        service.revoke('user_1', 'smtp_missing'),
      ).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('throws 404 when the credential belongs to another user', async () => {
      // La base ne rend rien : le filtre { id, userId } ne matche pas.
      findFirst.mockResolvedValue(null);

      await expect(service.revoke('user_1', 'smtp_1')).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      // E7 : la propriété est demandée à la base, pas vérifiée après coup.
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 'smtp_1', userId: 'user_1' },
        select: { id: true, revokedAt: true },
      });
      expect(update).not.toHaveBeenCalled();
    });

    it('sets revokedAt on an active credential', async () => {
      findFirst.mockResolvedValue({
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
      findFirst.mockResolvedValue({
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
      findFirst.mockResolvedValue(null);

      await expect(
        service.purge('user_1', 'smtp_missing'),
      ).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('throws 404 when the credential belongs to another user', async () => {
      findFirst.mockResolvedValue(null);

      await expect(service.purge('user_1', 'smtp_1')).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 'smtp_1', userId: 'user_1' },
        select: { id: true, revokedAt: true },
      });
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('refuses to delete an active credential (409)', async () => {
      findFirst.mockResolvedValue({
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
      findFirst.mockResolvedValue({
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
      findFirst.mockResolvedValue(null);

      await expect(
        service.rotate('user_1', 'smtp_missing'),
      ).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('throws 404 when the credential belongs to another user', async () => {
      findFirst.mockResolvedValue(null);

      await expect(service.rotate('user_1', 'smtp_1')).rejects.toMatchObject(
        new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE),
      );

      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 'smtp_1', userId: 'user_1' },
        select: {
          id: true,
          name: true,
          username: true,
          createdAt: true,
          revokedAt: true,
        },
      });
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses to rotate a revoked credential', async () => {
      findFirst.mockResolvedValue({
        ...rotatableCredential,
        revokedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await expect(service.rotate('user_1', 'smtp_1')).rejects.toMatchObject(
        new ConflictException(SMTP_CREDENTIAL_ROTATE_REVOKED_MESSAGE),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('regenerates prefix/secretHash in a single write, keeping id/name/username/createdAt — cutting the old secret immediately', async () => {
      findFirst.mockResolvedValue(rotatableCredential);

      const result = await service.rotate('user_1', 'smtp_1');

      // Une seule écriture (pas de second appel « désactive l'ancien puis
      // active le nouveau ») : la coupure est immédiate, sans grâce.
      expect(update).toHaveBeenCalledTimes(1);
      expect(capturedUpdateArgs).toBeDefined();
      expect(capturedUpdateArgs!.where).toEqual({ id: 'smtp_1' });
      expect(capturedUpdateArgs!.data.prefix).toBe(result.prefix);
      expect(capturedUpdateArgs!.data.secretHash).toBeDefined();
      expect(capturedUpdateArgs!.data.rotatedAt).toBeInstanceOf(Date);

      // La portée par domaine est immuable (B27) : la rotation n'y touche pas.
      expect(Object.keys(capturedUpdateArgs!.data).sort()).toEqual([
        'prefix',
        'rotatedAt',
        'secretHash',
      ]);

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
        domainScope: 'ALL',
        domains: [],
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

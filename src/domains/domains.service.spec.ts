import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DomainStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DOMAIN_ALREADY_REGISTERED_MESSAGE,
  DOMAIN_NOT_FOUND_MESSAGE,
} from './domains.constants';
import { DomainsService } from './domains.service';
import { SES_IDENTITY_DRIVER } from './ses/ses-identity-driver';

const CREATED_AT = new Date('2026-08-11T10:00:00.000Z');
const TOKENS = ['tokenaaa', 'tokenbbb', 'tokenccc'];

interface DomainCreateArgs {
  data: { userId: string; name: string; dkimTokens: string[] };
}

interface DomainUpdateArgs {
  where: { id: string };
  data: { status: DomainStatus; verifiedAt: Date | null };
}

function storedDomain(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dom_1',
    name: 'boutique-awa.gn',
    status: DomainStatus.PENDING,
    dkimTokens: TOKENS,
    verifiedAt: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe('DomainsService', () => {
  let service: DomainsService;
  let capturedUpdateArgs: DomainUpdateArgs | undefined;

  const domain = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const sesDriver = {
    createIdentity: jest.fn(),
    getIdentityStatus: jest.fn(),
    deleteIdentity: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedUpdateArgs = undefined;
    sesDriver.createIdentity.mockResolvedValue({ dkimTokens: TOKENS });
    sesDriver.deleteIdentity.mockResolvedValue(undefined);
    domain.create.mockImplementation((args: DomainCreateArgs) =>
      Promise.resolve(
        storedDomain({
          name: args.data.name,
          dkimTokens: args.data.dkimTokens,
        }),
      ),
    );
    domain.update.mockImplementation((args: DomainUpdateArgs) => {
      capturedUpdateArgs = args;
      return Promise.resolve({
        id: args.where.id,
        status: args.data.status,
        verifiedAt: args.data.verifiedAt,
      });
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DomainsService,
        { provide: PrismaService, useValue: { domain } },
        { provide: SES_IDENTITY_DRIVER, useValue: sesDriver },
      ],
    }).compile();

    service = module.get<DomainsService>(DomainsService);
  });

  describe('create', () => {
    it('normalises the name, stores the SES tokens and returns the DKIM records', async () => {
      domain.findUnique.mockResolvedValue(null);

      const result = await service.create('user_1', '  Boutique-Awa.GN  ');

      expect(sesDriver.createIdentity).toHaveBeenCalledWith('boutique-awa.gn');
      expect(domain.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            userId: 'user_1',
            name: 'boutique-awa.gn',
            dkimTokens: TOKENS,
          },
        }),
      );

      expect(result).toMatchObject({
        id: 'dom_1',
        name: 'boutique-awa.gn',
        status: DomainStatus.PENDING,
        createdAt: CREATED_AT,
      });
      expect(result.dkimRecords).toEqual([
        {
          type: 'CNAME',
          name: 'tokenaaa._domainkey.boutique-awa.gn',
          value: 'tokenaaa.dkim.amazonses.com',
        },
        {
          type: 'CNAME',
          name: 'tokenbbb._domainkey.boutique-awa.gn',
          value: 'tokenbbb.dkim.amazonses.com',
        },
        {
          type: 'CNAME',
          name: 'tokenccc._domainkey.boutique-awa.gn',
          value: 'tokenccc.dkim.amazonses.com',
        },
      ]);
    });

    it('joins SPF and DMARC recommendations to the response', async () => {
      domain.findUnique.mockResolvedValue(null);

      const result = await service.create('user_1', 'boutique-awa.gn');

      expect(result.recommendedRecords).toEqual([
        expect.objectContaining({
          purpose: 'SPF',
          type: 'TXT',
          name: 'boutique-awa.gn',
          value: 'v=spf1 include:amazonses.com ~all',
        }),
        expect.objectContaining({
          purpose: 'DMARC',
          type: 'TXT',
          name: '_dmarc.boutique-awa.gn',
          value: 'v=DMARC1; p=none;',
        }),
      ]);
      expect(result.recommendedRecords[0].note).not.toHaveLength(0);
      expect(result.recommendedRecords[1].note).not.toHaveLength(0);
    });

    it.each([
      ['http://x.com', 'protocole'],
      ['https://boutique-awa.gn/', 'protocole et chemin'],
      ['pas-de-point', 'aucun point'],
      ['1.2.3.4', 'adresse IP'],
      ['boutique-awa.g', 'TLD trop court'],
      ['-invalide.gn', 'label commençant par un tiret'],
      ['boutique awa.gn', 'espace interne'],
      ['contact@boutique-awa.gn', 'adresse email'],
    ])('rejects %s (%s) with a 400', async (name) => {
      await expect(service.create('user_1', name)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(sesDriver.createIdentity).not.toHaveBeenCalled();
      expect(domain.create).not.toHaveBeenCalled();
    });

    it('accepts a plain domain and a subdomain', async () => {
      domain.findUnique.mockResolvedValue(null);

      await expect(
        service.create('user_1', 'boutique-awa.gn'),
      ).resolves.toBeDefined();
      await expect(
        service.create('user_1', 'mail.boutique-awa.gn'),
      ).resolves.toBeDefined();
    });

    it('rejects an already registered domain with a neutral 409', async () => {
      domain.findUnique.mockResolvedValue({ id: 'dom_other' });

      await expect(
        service.create('user_1', 'boutique-awa.gn'),
      ).rejects.toMatchObject(
        new ConflictException(DOMAIN_ALREADY_REGISTERED_MESSAGE),
      );

      expect(sesDriver.createIdentity).not.toHaveBeenCalled();
      expect(domain.create).not.toHaveBeenCalled();
    });

    it('maps a Prisma P2002 unique violation to the same neutral 409', async () => {
      domain.findUnique.mockResolvedValue(null);
      domain.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      await expect(
        service.create('user_1', 'boutique-awa.gn'),
      ).rejects.toMatchObject(
        new ConflictException(DOMAIN_ALREADY_REGISTERED_MESSAGE),
      );
    });
  });

  describe('list', () => {
    it('only lists the domains of the current user', async () => {
      domain.findMany.mockResolvedValue([]);

      await service.list('user_1');

      expect(domain.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user_1' } }),
      );
    });
  });

  describe('findOne', () => {
    it('scopes the lookup to the owner and returns the DNS records', async () => {
      domain.findFirst.mockResolvedValue(storedDomain());

      const result = await service.findOne('user_1', 'dom_1');

      expect(domain.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'dom_1', userId: 'user_1' } }),
      );
      expect(result.dkimRecords).toHaveLength(3);
      expect(result.recommendedRecords).toHaveLength(2);
    });

    it("returns a 404 for another user's domain", async () => {
      domain.findFirst.mockResolvedValue(null);

      await expect(service.findOne('user_2', 'dom_1')).rejects.toMatchObject(
        new NotFoundException(DOMAIN_NOT_FOUND_MESSAGE),
      );
    });
  });

  describe('check', () => {
    it('moves PENDING to VERIFIED and stamps verifiedAt', async () => {
      domain.findFirst.mockResolvedValue(storedDomain());
      sesDriver.getIdentityStatus.mockResolvedValue(DomainStatus.VERIFIED);

      const result = await service.check('user_1', 'dom_1');

      expect(sesDriver.getIdentityStatus).toHaveBeenCalledWith(
        'boutique-awa.gn',
      );
      expect(capturedUpdateArgs).toBeDefined();
      expect(capturedUpdateArgs!.where).toEqual({ id: 'dom_1' });
      expect(capturedUpdateArgs!.data.status).toBe(DomainStatus.VERIFIED);
      expect(capturedUpdateArgs!.data.verifiedAt).toBeInstanceOf(Date);

      expect(result.status).toBe(DomainStatus.VERIFIED);
      expect(result.verifiedAt).toBeInstanceOf(Date);
    });

    it('keeps verifiedAt null while SES still reports PENDING', async () => {
      domain.findFirst.mockResolvedValue(storedDomain());
      sesDriver.getIdentityStatus.mockResolvedValue(DomainStatus.PENDING);

      const result = await service.check('user_1', 'dom_1');

      expect(result).toEqual({
        id: 'dom_1',
        status: DomainStatus.PENDING,
        verifiedAt: null,
      });
    });

    it('does not re-stamp verifiedAt on an already verified domain', async () => {
      const verifiedAt = new Date('2026-08-01T08:00:00.000Z');
      domain.findFirst.mockResolvedValue(
        storedDomain({ status: DomainStatus.VERIFIED, verifiedAt }),
      );
      sesDriver.getIdentityStatus.mockResolvedValue(DomainStatus.VERIFIED);

      const result = await service.check('user_1', 'dom_1');

      expect(result.verifiedAt).toEqual(verifiedAt);
    });

    it("returns a 404 for another user's domain and never calls SES", async () => {
      domain.findFirst.mockResolvedValue(null);

      await expect(service.check('user_2', 'dom_1')).rejects.toMatchObject(
        new NotFoundException(DOMAIN_NOT_FOUND_MESSAGE),
      );

      expect(sesDriver.getIdentityStatus).not.toHaveBeenCalled();
      expect(domain.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes the SES identity then the row', async () => {
      domain.findFirst.mockResolvedValue(storedDomain());
      domain.delete.mockResolvedValue(storedDomain());

      await service.remove('user_1', 'dom_1');

      expect(sesDriver.deleteIdentity).toHaveBeenCalledWith('boutique-awa.gn');
      expect(domain.delete).toHaveBeenCalledWith({ where: { id: 'dom_1' } });
    });

    it("returns a 404 for another user's domain and deletes nothing", async () => {
      domain.findFirst.mockResolvedValue(null);

      await expect(service.remove('user_2', 'dom_1')).rejects.toMatchObject(
        new NotFoundException(DOMAIN_NOT_FOUND_MESSAGE),
      );

      expect(sesDriver.deleteIdentity).not.toHaveBeenCalled();
      expect(domain.delete).not.toHaveBeenCalled();
    });
  });
});

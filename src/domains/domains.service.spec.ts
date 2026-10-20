import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainStatus, Prisma } from '@prisma/client';
import { resolveCname } from 'node:dns/promises';
import { PrismaService } from '../prisma/prisma.service';
import {
  DOMAIN_ALREADY_REGISTERED_MESSAGE,
  DOMAIN_NOT_FOUND_MESSAGE,
} from './domains.constants';
import { DomainsService } from './domains.service';
import { SES_IDENTITY_DRIVER } from './ses/ses-identity-driver';

// Le diagnostic DNS (`dnsCheck`) résout du DNS réel via `node:dns/promises` :
// jamais de vrai réseau en test.
jest.mock('node:dns/promises', () => ({
  resolveCname: jest.fn(),
  resolveMx: jest.fn(),
  resolveTxt: jest.fn(),
  resolve4: jest.fn(),
}));

const mockResolveCname = resolveCname as unknown as jest.Mock;

const CREATED_AT = new Date('2026-08-11T10:00:00.000Z');
const TOKENS = ['tokenaaa', 'tokenbbb', 'tokenccc'];

interface DomainCreateArgs {
  data: { userId: string; name: string; dkimTokens: string[] };
}

interface DomainUpdateArgs {
  where: { id: string };
  data: {
    status: DomainStatus;
    verifiedAt: Date | null;
    mailFromStatus?: string;
  };
}

function storedDomain(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dom_1',
    name: 'boutique-awa.gn',
    status: DomainStatus.PENDING,
    dkimTokens: TOKENS,
    mailFromStatus: null,
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
  // Liens de portée (B27), lus puis retirés dans la transaction de suppression.
  const apiKeyDomain = { findMany: jest.fn(), deleteMany: jest.fn() };
  const smtpCredentialDomain = { findMany: jest.fn(), deleteMany: jest.fn() };
  const apiKey = { updateMany: jest.fn() };
  const smtpCredential = { updateMany: jest.fn() };
  const callOrder: string[] = [];
  const prismaDouble: Record<string, unknown> = {};
  const sesDriver = {
    createIdentity: jest.fn(),
    getIdentityStatus: jest.fn(),
    deleteIdentity: jest.fn(),
  };

  /** Région SES configurée, réglée par test. */
  let awsRegion: string | undefined;

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedUpdateArgs = undefined;
    awsRegion = 'eu-west-3';
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
        mailFromStatus: args.data.mailFromStatus ?? null,
      });
    });

    apiKeyDomain.findMany.mockResolvedValue([]);
    smtpCredentialDomain.findMany.mockResolvedValue([]);
    apiKey.updateMany.mockResolvedValue({ count: 0 });
    smtpCredential.updateMany.mockResolvedValue({ count: 0 });
    apiKeyDomain.deleteMany.mockResolvedValue({ count: 0 });
    smtpCredentialDomain.deleteMany.mockResolvedValue({ count: 0 });
    domain.delete.mockResolvedValue(storedDomain());
    Object.assign(prismaDouble, {
      domain,
      apiKey,
      smtpCredential,
      apiKeyDomain,
      smtpCredentialDomain,
      $transaction: jest.fn((run: (tx: unknown) => Promise<unknown>) =>
        run(prismaDouble),
      ),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DomainsService,
        { provide: PrismaService, useValue: prismaDouble },
        { provide: SES_IDENTITY_DRIVER, useValue: sesDriver },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'AWS_REGION' ? awsRegion : undefined,
          },
        },
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

    it('joins MAIL FROM (MX + SPF on bounce.) and DMARC recommendations to the response', async () => {
      domain.findUnique.mockResolvedValue(null);

      const result = await service.create('user_1', 'boutique-awa.gn');

      expect(result.mailFromDomain).toBe('bounce.boutique-awa.gn');
      expect(result.recommendedRecords).toEqual([
        expect.objectContaining({
          purpose: 'MX',
          type: 'MX',
          name: 'bounce.boutique-awa.gn',
          value: 'feedback-smtp.eu-west-3.amazonses.com',
          priority: 10,
        }),
        expect.objectContaining({
          purpose: 'SPF',
          type: 'TXT',
          name: 'bounce.boutique-awa.gn',
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

    it('takes the MX region from the configuration, not a hard-coded value', async () => {
      awsRegion = 'us-east-1';
      domain.findUnique.mockResolvedValue(null);

      const result = await service.create('user_1', 'boutique-awa.gn');

      expect(result.recommendedRecords[0].value).toBe(
        'feedback-smtp.us-east-1.amazonses.com',
      );
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
      expect(result.recommendedRecords).toHaveLength(3);
      expect(result.mailFromDomain).toBe('bounce.boutique-awa.gn');
      expect(result.mailFromStatus).toBeNull();
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
      sesDriver.getIdentityStatus.mockResolvedValue({
        status: DomainStatus.VERIFIED,
        mailFromStatus: 'SUCCESS',
      });

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
      // Le statut MAIL FROM relu chez SES est persisté et exposé.
      expect(capturedUpdateArgs!.data.mailFromStatus).toBe('SUCCESS');
      expect(result.mailFromStatus).toBe('SUCCESS');
    });

    it('keeps verifiedAt null while SES still reports PENDING', async () => {
      domain.findFirst.mockResolvedValue(storedDomain());
      sesDriver.getIdentityStatus.mockResolvedValue({
        status: DomainStatus.PENDING,
        mailFromStatus: 'PENDING',
      });

      const result = await service.check('user_1', 'dom_1');

      expect(result).toEqual({
        id: 'dom_1',
        status: DomainStatus.PENDING,
        verifiedAt: null,
        mailFromStatus: 'PENDING',
      });
    });

    it('keeps the last known MAIL FROM status when SES could not be read', async () => {
      domain.findFirst.mockResolvedValue(
        storedDomain({ mailFromStatus: 'SUCCESS' }),
      );
      sesDriver.getIdentityStatus.mockResolvedValue({
        status: DomainStatus.PENDING,
        mailFromStatus: null,
      });

      await service.check('user_1', 'dom_1');

      expect(capturedUpdateArgs!.data).not.toHaveProperty('mailFromStatus');
    });

    it('does not re-stamp verifiedAt on an already verified domain', async () => {
      const verifiedAt = new Date('2026-08-01T08:00:00.000Z');
      domain.findFirst.mockResolvedValue(
        storedDomain({ status: DomainStatus.VERIFIED, verifiedAt }),
      );
      sesDriver.getIdentityStatus.mockResolvedValue({
        status: DomainStatus.VERIFIED,
        mailFromStatus: 'SUCCESS',
      });

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

  describe('dnsCheck', () => {
    it('scopes the lookup to the owner and returns the DNS diagnostic', async () => {
      domain.findFirst.mockResolvedValue(storedDomain());
      mockResolveCname.mockResolvedValue([`${TOKENS[0]}.dkim.amazonses.com`]);

      const result = await service.dnsCheck('user_1', 'dom_1');

      expect(domain.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'dom_1', userId: 'user_1' } }),
      );
      expect(result.domainId).toBe('dom_1');
      expect(result.domainName).toBe('boutique-awa.gn');
      expect(result.dkim).toHaveLength(3);
      expect(result.sesStatus).toBe(DomainStatus.PENDING);
    });

    it("returns a 404 for another user's domain and never resolves DNS", async () => {
      domain.findFirst.mockResolvedValue(null);

      await expect(service.dnsCheck('user_2', 'dom_1')).rejects.toMatchObject(
        new NotFoundException(DOMAIN_NOT_FOUND_MESSAGE),
      );

      expect(mockResolveCname).not.toHaveBeenCalled();
    });
  });

  describe("usage (aperçu d'impact, B27)", () => {
    it('liste les clés et identifiants actifs liés, avec willBeRevoked pour le dernier domaine', async () => {
      domain.findFirst.mockResolvedValue(storedDomain());
      apiKeyDomain.findMany.mockResolvedValue([
        {
          apiKey: {
            id: 'key_1',
            name: 'Vitrine',
            prefix: 'zd_live_aaaa',
            _count: { domains: 1 },
          },
        },
        {
          apiKey: {
            id: 'key_2',
            name: 'Multi',
            prefix: 'zd_live_bbbb',
            _count: { domains: 2 },
          },
        },
      ]);
      smtpCredentialDomain.findMany.mockResolvedValue([
        {
          smtpCredential: {
            id: 'smtp_1',
            name: 'WordPress',
            username: 'zdu_aaaa',
            prefix: 'zd_smtp_aaaa',
            _count: { domains: 1 },
          },
        },
      ]);

      await expect(service.usage('user_1', 'dom_1')).resolves.toEqual({
        apiKeys: [
          {
            id: 'key_1',
            name: 'Vitrine',
            prefix: 'zd_live_aaaa',
            willBeRevoked: true,
          },
          {
            id: 'key_2',
            name: 'Multi',
            prefix: 'zd_live_bbbb',
            willBeRevoked: false,
          },
        ],
        smtpCredentials: [
          {
            id: 'smtp_1',
            name: 'WordPress',
            username: 'zdu_aaaa',
            prefix: 'zd_smtp_aaaa',
            willBeRevoked: true,
          },
        ],
      });

      // Seuls les liens ACTIFS de CE domaine comptent.
      expect(apiKeyDomain.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { domainId: 'dom_1', apiKey: { revokedAt: null } },
        }),
      );
      expect(smtpCredentialDomain.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { domainId: 'dom_1', smtpCredential: { revokedAt: null } },
        }),
      );
      // Lecture pure.
      expect(sesDriver.deleteIdentity).not.toHaveBeenCalled();
      expect(domain.delete).not.toHaveBeenCalled();
    });

    it("rend un 404 pour le domaine d'un autre compte, sans lire de lien", async () => {
      domain.findFirst.mockResolvedValue(null);

      await expect(service.usage('user_2', 'dom_1')).rejects.toMatchObject(
        new NotFoundException(DOMAIN_NOT_FOUND_MESSAGE),
      );

      expect(apiKeyDomain.findMany).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes the SES identity then the row', async () => {
      domain.findFirst.mockResolvedValue(storedDomain());
      domain.delete.mockResolvedValue(storedDomain());

      const result = await service.remove('user_1', 'dom_1');

      expect(sesDriver.deleteIdentity).toHaveBeenCalledWith('boutique-awa.gn');
      expect(domain.delete).toHaveBeenCalledWith({ where: { id: 'dom_1' } });
      expect(result).toEqual({
        revokedApiKeys: [],
        revokedSmtpCredentials: [],
      });
      // Rien à révoquer : aucune écriture sur les clés.
      expect(apiKey.updateMany).not.toHaveBeenCalled();
      expect(smtpCredential.updateMany).not.toHaveBeenCalled();
    });

    describe('portée des clés et identifiants (B27)', () => {
      beforeEach(() => {
        domain.findFirst.mockResolvedValue(storedDomain());
        apiKeyDomain.findMany.mockResolvedValue([
          {
            apiKey: {
              id: 'key_seule',
              name: 'Vitrine',
              prefix: 'zd_live_aaaa',
              _count: { domains: 1 },
            },
          },
          {
            apiKey: {
              id: 'key_multi',
              name: 'Multi',
              prefix: 'zd_live_bbbb',
              _count: { domains: 2 },
            },
          },
        ]);
        smtpCredentialDomain.findMany.mockResolvedValue([
          {
            smtpCredential: {
              id: 'smtp_seul',
              name: 'WordPress',
              username: 'zdu_aaaa',
              prefix: 'zd_smtp_aaaa',
              _count: { domains: 1 },
            },
          },
          {
            smtpCredential: {
              id: 'smtp_multi',
              name: 'ERP',
              username: 'zdu_bbbb',
              prefix: 'zd_smtp_bbbb',
              _count: { domains: 3 },
            },
          },
        ]);
      });

      it('révoque seulement ceux qui perdent leur DERNIER domaine, et le dit', async () => {
        const result = await service.remove('user_1', 'dom_1');

        expect(apiKey.updateMany).toHaveBeenCalledTimes(1);
        expect(apiKey.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['key_seule'] } },
          data: { revokedAt: expect.any(Date) as Date },
        });
        expect(smtpCredential.updateMany).toHaveBeenCalledTimes(1);
        expect(smtpCredential.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['smtp_seul'] } },
          data: { revokedAt: expect.any(Date) as Date },
        });
        expect(result).toEqual({
          revokedApiKeys: [
            { id: 'key_seule', name: 'Vitrine', prefix: 'zd_live_aaaa' },
          ],
          revokedSmtpCredentials: [
            {
              id: 'smtp_seul',
              name: 'WordPress',
              username: 'zdu_aaaa',
              prefix: 'zd_smtp_aaaa',
            },
          ],
        });
      });

      it('retire les liens du domaine avant de le supprimer, dans la même transaction', async () => {
        callOrder.length = 0;
        apiKey.updateMany.mockImplementation(() => {
          callOrder.push('revokeApiKeys');
          return Promise.resolve({ count: 1 });
        });
        smtpCredential.updateMany.mockImplementation(() => {
          callOrder.push('revokeSmtp');
          return Promise.resolve({ count: 1 });
        });
        apiKeyDomain.deleteMany.mockImplementation(() => {
          callOrder.push('unlinkApiKeys');
          return Promise.resolve({ count: 2 });
        });
        smtpCredentialDomain.deleteMany.mockImplementation(() => {
          callOrder.push('unlinkSmtp');
          return Promise.resolve({ count: 2 });
        });
        domain.delete.mockImplementation(() => {
          callOrder.push('deleteDomain');
          return Promise.resolve(storedDomain());
        });

        await service.remove('user_1', 'dom_1');

        expect(prismaDouble.$transaction).toHaveBeenCalledTimes(1);
        expect(apiKeyDomain.deleteMany).toHaveBeenCalledWith({
          where: { domainId: 'dom_1' },
        });
        expect(smtpCredentialDomain.deleteMany).toHaveBeenCalledWith({
          where: { domainId: 'dom_1' },
        });
        expect(callOrder.indexOf('deleteDomain')).toBe(callOrder.length - 1);
        expect(callOrder).toEqual(
          expect.arrayContaining([
            'revokeApiKeys',
            'revokeSmtp',
            'unlinkApiKeys',
            'unlinkSmtp',
            'deleteDomain',
          ]),
        );
      });

      it("n'élargit jamais : aucune écriture ne touche à domainScope", async () => {
        await service.remove('user_1', 'dom_1');

        const calls = [
          ...(apiKey.updateMany.mock.calls as unknown[]),
          ...(smtpCredential.updateMany.mock.calls as unknown[]),
        ] as [{ data: Record<string, unknown> }][];

        for (const call of calls) {
          expect(Object.keys(call[0].data)).toEqual(['revokedAt']);
        }
      });

      it('ne supprime rien (ni lien ni domaine) quand SES échoue, et ne révoque rien', async () => {
        sesDriver.deleteIdentity.mockRejectedValueOnce(new Error('SES down'));

        await expect(service.remove('user_1', 'dom_1')).rejects.toThrow(
          'SES down',
        );

        expect(apiKey.updateMany).not.toHaveBeenCalled();
        expect(apiKeyDomain.deleteMany).not.toHaveBeenCalled();
        expect(domain.delete).not.toHaveBeenCalled();
      });
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

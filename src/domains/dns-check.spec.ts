import { DomainStatus } from '@prisma/client';
import { resolve4, resolveCname, resolveTxt } from 'node:dns/promises';
import { checkDomainDns, isCloudflareIp } from './dns-check';

jest.mock('node:dns/promises', () => ({
  resolveCname: jest.fn(),
  resolveTxt: jest.fn(),
  resolve4: jest.fn(),
}));

const mockResolveCname = resolveCname as unknown as jest.Mock;
const mockResolveTxt = resolveTxt as unknown as jest.Mock;
const mockResolve4 = resolve4 as unknown as jest.Mock;

/** Erreur DNS « pas de données de ce type à ce nom » (comme Node la produit). */
function notFoundError(code: 'ENOTFOUND' | 'ENODATA' = 'ENODATA'): Error {
  return Object.assign(new Error(`queryCname ${code}`), { code });
}

const DOMAIN_NAME = 'boutique-awa.gn';

function domainFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dom_1',
    name: DOMAIN_NAME,
    dkimTokens: ['abc123token'],
    status: DomainStatus.PENDING,
    ...overrides,
  };
}

describe('checkDomainDns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // SPF/DMARC ne sont pas sous test dans les scénarios DKIM ci-dessous :
    // tout TXT renvoie « introuvable » par défaut, sans casser le test.
    mockResolveTxt.mockRejectedValue(notFoundError());
    // Idem pour le repli A générique : absent par défaut.
    mockResolve4.mockRejectedValue(notFoundError());
  });

  describe('DKIM', () => {
    it('classe ok un CNAME correct', async () => {
      mockResolveCname.mockResolvedValue(['abc123token.dkim.amazonses.com']);

      const result = await checkDomainDns(domainFixture());

      expect(result.dkim).toHaveLength(1);
      expect(result.dkim[0]).toMatchObject({
        status: 'ok',
        attendu: 'abc123token.dkim.amazonses.com',
        trouve: 'abc123token.dkim.amazonses.com',
      });
      expect(result.dkim[0].diagnostic).toBeUndefined();
    });

    it('classe ok malgré une casse différente et un point final', async () => {
      mockResolveCname.mockResolvedValue(['ABC123TOKEN.DKIM.AmazonSES.com.']);

      const result = await checkDomainDns(domainFixture());

      expect(result.dkim[0].status).toBe('ok');
    });

    it('classe introuvable un enregistrement absent (aucun A ni CNAME)', async () => {
      mockResolveCname.mockRejectedValue(notFoundError());
      mockResolve4.mockRejectedValue(notFoundError());

      const result = await checkDomainDns(domainFixture());

      expect(result.dkim[0]).toMatchObject({
        status: 'introuvable',
        trouve: null,
      });
      expect(result.dkim[0].diagnostic).toBeUndefined();
    });

    it('classe valeur_differente un CNAME qui pointe ailleurs', async () => {
      mockResolveCname.mockResolvedValue(['autrechose.example.com']);

      const result = await checkDomainDns(domainFixture());

      expect(result.dkim[0]).toMatchObject({
        status: 'valeur_differente',
        trouve: 'autrechose.example.com',
      });
      expect(result.dkim[0].diagnostic).toBeUndefined();
    });

    it('nomme le proxy Cloudflare quand le CNAME résout vers une IP Cloudflare', async () => {
      mockResolveCname.mockRejectedValue(notFoundError());
      mockResolve4.mockResolvedValue([{ address: '104.16.10.20', ttl: 300 }]);

      const result = await checkDomainDns(domainFixture());

      expect(result.dkim[0]).toMatchObject({
        status: 'valeur_differente',
        diagnostic: 'proxy_cloudflare',
        trouve: '104.16.10.20',
        ttl: 300,
      });
      expect(result.dkim[0].message).toMatch(/cloudflare/i);
    });

    it('nomme un aplatissement CNAME quand la réponse est une IP non-Cloudflare', async () => {
      mockResolveCname.mockRejectedValue(notFoundError());
      mockResolve4.mockResolvedValue([{ address: '203.0.113.42', ttl: 3600 }]);

      const result = await checkDomainDns(domainFixture());

      expect(result.dkim[0]).toMatchObject({
        status: 'valeur_differente',
        diagnostic: 'cname_aplati',
        trouve: '203.0.113.42',
        ttl: 3600,
      });
      expect(result.dkim[0].message).toMatch(/CNAME/);
    });

    it('nomme le domaine dupliqué quand le CNAME correct existe sous <token>._domainkey.<domaine>.<domaine>', async () => {
      const token = 'abc123token';
      const expectedName = `${token}._domainkey.${DOMAIN_NAME}`;
      const duplicatedName = `${expectedName}.${DOMAIN_NAME}`;

      mockResolveCname.mockImplementation((name: string) => {
        if (name === duplicatedName) {
          return Promise.resolve([`${token}.dkim.amazonses.com`]);
        }
        return Promise.reject(notFoundError());
      });

      const result = await checkDomainDns(
        domainFixture({ dkimTokens: [token] }),
      );

      expect(result.dkim[0]).toMatchObject({
        status: 'introuvable',
        trouve: null,
        diagnostic: 'domaine_duplique',
      });
      expect(result.dkim[0].message).toContain(duplicatedName);
      // Le repli A n'a pas de raison d'être tenté une fois le duplicata trouvé.
      expect(mockResolve4).not.toHaveBeenCalled();
    });

    it('vérifie chacun des 3 jetons DKIM indépendamment', async () => {
      mockResolveCname.mockImplementation((name: string) => {
        if (name.startsWith('token-ok')) {
          return Promise.resolve(['token-ok.dkim.amazonses.com']);
        }
        return Promise.reject(notFoundError());
      });

      const result = await checkDomainDns(
        domainFixture({
          dkimTokens: ['token-ok', 'token-absent', 'token-absent-2'],
        }),
      );

      expect(result.dkim).toHaveLength(3);
      expect(result.dkim[0].status).toBe('ok');
      expect(result.dkim[1].status).toBe('introuvable');
      expect(result.dkim[2].status).toBe('introuvable');
    });
  });

  describe('SPF', () => {
    it('classe ok quand include:amazonses.com est présent', async () => {
      mockResolveCname.mockRejectedValue(notFoundError());
      mockResolveTxt.mockImplementation((name: string) => {
        if (name === DOMAIN_NAME) {
          return Promise.resolve([['v=spf1 include:amazonses.com ~all']]);
        }
        return Promise.reject(notFoundError());
      });

      const result = await checkDomainDns(domainFixture());

      expect(result.spf.status).toBe('ok');
    });

    it('classe valeur_differente quand un SPF existe sans amazonses.com', async () => {
      mockResolveCname.mockRejectedValue(notFoundError());
      mockResolveTxt.mockImplementation((name: string) => {
        if (name === DOMAIN_NAME) {
          return Promise.resolve([['v=spf1 include:_spf.google.com ~all']]);
        }
        return Promise.reject(notFoundError());
      });

      const result = await checkDomainDns(domainFixture());

      expect(result.spf.status).toBe('valeur_differente');
    });

    it('classe introuvable quand aucun TXT SPF ne répond', async () => {
      mockResolveCname.mockRejectedValue(notFoundError());
      mockResolveTxt.mockRejectedValue(notFoundError());

      const result = await checkDomainDns(domainFixture());

      expect(result.spf).toMatchObject({ status: 'introuvable', trouve: null });
    });
  });

  describe('DMARC', () => {
    it('classe ok quand _dmarc.<domaine> porte un enregistrement DMARC', async () => {
      mockResolveCname.mockRejectedValue(notFoundError());
      mockResolveTxt.mockImplementation((name: string) => {
        if (name === `_dmarc.${DOMAIN_NAME}`) {
          return Promise.resolve([['v=DMARC1; p=none;']]);
        }
        return Promise.reject(notFoundError());
      });

      const result = await checkDomainDns(domainFixture());

      expect(result.dmarc.status).toBe('ok');
      expect(result.dmarc.name).toBe(`_dmarc.${DOMAIN_NAME}`);
    });

    it('classe introuvable quand _dmarc.<domaine> ne répond rien', async () => {
      mockResolveCname.mockRejectedValue(notFoundError());
      mockResolveTxt.mockRejectedValue(notFoundError());

      const result = await checkDomainDns(domainFixture());

      expect(result.dmarc).toMatchObject({
        status: 'introuvable',
        trouve: null,
      });
    });
  });

  it("n'appelle jamais SES : rapporte seulement le statut déjà connu en base", async () => {
    mockResolveCname.mockResolvedValue(['abc123token.dkim.amazonses.com']);

    const result = await checkDomainDns(
      domainFixture({ status: DomainStatus.VERIFIED }),
    );

    expect(result.sesStatus).toBe(DomainStatus.VERIFIED);
    expect(result.domainId).toBe('dom_1');
    expect(result.domainName).toBe(DOMAIN_NAME);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });
});

describe('isCloudflareIp', () => {
  it('reconnaît une IP dans une plage Cloudflare publiée', () => {
    expect(isCloudflareIp('104.16.0.1')).toBe(true);
    expect(isCloudflareIp('172.67.0.1')).toBe(true);
  });

  it('rejette une IP hors des plages Cloudflare', () => {
    expect(isCloudflareIp('203.0.113.42')).toBe(false);
    expect(isCloudflareIp('8.8.8.8')).toBe(false);
  });
});

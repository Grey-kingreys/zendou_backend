import { createHash, createHmac } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UserRole, UserStatus } from '@prisma/client';
import type { AuthUser } from '../auth';
import { PrismaService } from '../prisma/prisma.service';
import { SmtpAuthService } from './smtp-auth.service';

const PEPPER = 'p'.repeat(64);
const USERNAME = 'zdu_aaaaaaaaaaaaaaaa';
const SECRET = `zd_smtp_${'d'.repeat(43)}`;

const legacyHash = createHash('sha256').update(SECRET).digest('hex');
const pepperedHash = createHmac('sha256', PEPPER).update(SECRET).digest('hex');

const owner: AuthUser = {
  id: 'user_1',
  email: 'aissatou@example.com',
  name: 'Aïssatou Diallo',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

/**
 * E3 côté relais SMTP : même mécanique que `ApiKeyAuthGuard`, sur la colonne
 * `secretHash`. La différence est le chemin de reconnaissance - ici le nom
 * d'utilisateur mène à la ligne et la comparaison des empreintes est
 * explicite, alors que le garde HTTP retrouve la clé *par* son empreinte.
 */
describe('SmtpAuthService - poivre et migration paresseuse (E3)', () => {
  interface Row {
    id: string;
    username: string;
    secretHash: string;
    revokedAt: Date | null;
  }

  let row: Row;
  let service: SmtpAuthService;

  const findUnique = jest.fn(({ where }: { where: { username: string } }) =>
    Promise.resolve(
      where.username === row.username
        ? {
            id: row.id,
            username: row.username,
            secretHash: row.secretHash,
            revokedAt: row.revokedAt,
            user: owner,
          }
        : null,
    ),
  );
  const update = jest.fn(
    ({
      data,
    }: {
      where: { id: string };
      data: { secretHash?: string; lastUsedAt?: Date };
    }) => {
      if (data.secretHash) {
        row.secretHash = data.secretHash;
      }
      return Promise.resolve({});
    },
  );

  /** Écritures qui touchent réellement l'empreinte (et non `lastUsedAt`). */
  function hashRewrites() {
    return update.mock.calls.filter(
      ([args]: [{ data: { secretHash?: string } }]) =>
        args.data.secretHash !== undefined,
    );
  }

  async function buildService(pepper?: string): Promise<SmtpAuthService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmtpAuthService,
        {
          provide: PrismaService,
          useValue: { smtpCredential: { findUnique, update } },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'API_KEY_PEPPER' ? pepper : undefined,
          },
        },
      ],
    }).compile();

    return module.get<SmtpAuthService>(SmtpAuthService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    row = {
      id: 'smtp_1',
      username: USERNAME,
      secretHash: legacyHash,
      revokedAt: null,
    };
    service = await buildService(PEPPER);
  });

  it('accepte un secret dont la base porte encore l’empreinte historique, puis la réécrit poivrée', async () => {
    await expect(
      service.authenticate(USERNAME, SECRET, '203.0.113.10'),
    ).resolves.toMatchObject({ credentialId: 'smtp_1', username: USERNAME });

    expect(hashRewrites()).toHaveLength(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'smtp_1' },
      data: { secretHash: pepperedHash },
    });
    expect(row.secretHash).toBe(pepperedHash);
  });

  it('accepte un secret déjà poivré sans jamais réécrire son empreinte', async () => {
    row.secretHash = pepperedHash;

    await expect(
      service.authenticate(USERNAME, SECRET, '203.0.113.10'),
    ).resolves.toMatchObject({ credentialId: 'smtp_1' });

    expect(hashRewrites()).toHaveLength(0);
  });

  it('refuse un secret faux, sans rien réécrire', async () => {
    await expect(
      service.authenticate(USERNAME, 'zd_smtp_mauvais', '203.0.113.10'),
    ).rejects.toMatchObject({ responseCode: 535 });

    expect(hashRewrites()).toHaveLength(0);
    expect(row.secretHash).toBe(legacyHash);
  });

  it('refuse un identifiant révoqué même avec le bon secret historique', async () => {
    row.revokedAt = new Date('2026-01-01T00:00:00.000Z');

    await expect(
      service.authenticate(USERNAME, SECRET, '203.0.113.10'),
    ).rejects.toMatchObject({ responseCode: 535 });

    expect(hashRewrites()).toHaveLength(0);
  });

  it('laisse passer l’authentification quand la réécriture échoue', async () => {
    update.mockRejectedValueOnce(new Error('base en lecture seule'));

    await expect(
      service.authenticate(USERNAME, SECRET, '203.0.113.10'),
    ).resolves.toMatchObject({ credentialId: 'smtp_1' });
  });

  it('sans poivre, accepte le secret historique et ne migre rien', async () => {
    service = await buildService(undefined);

    await expect(
      service.authenticate(USERNAME, SECRET, '203.0.113.10'),
    ).resolves.toMatchObject({ credentialId: 'smtp_1' });

    expect(hashRewrites()).toHaveLength(0);
    expect(row.secretHash).toBe(legacyHash);
  });
});

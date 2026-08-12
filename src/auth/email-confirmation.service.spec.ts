import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { EmailsService } from '../emails/emails.service';
import type { SystemEmailPayload } from '../emails/emails.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALREADY_CONFIRMED_MESSAGE,
  EMAIL_CONFIRMATION_TTL_HOURS,
  INVALID_CONFIRMATION_TOKEN_MESSAGE,
  SUPPRESSED_ADDRESS_MESSAGE,
} from './email-confirmation.constants';
import {
  EmailConfirmationService,
  hashConfirmationToken,
} from './email-confirmation.service';

const USER_ID = 'user_1';
const USER_EMAIL = 'aissatou@example.com';
const USER_NAME = 'Aïssatou Diallo';

interface UserRow {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: Date | null;
  emailVerificationTokenHash: string | null;
  emailVerificationSentTo: string | null;
  emailVerificationExpiresAt: Date | null;
}

interface SuppressionRow {
  address: string;
  userId: string | null;
}

/**
 * Double en mémoire de `PrismaService` avec une sémantique de requête réelle :
 * `findUnique` cherche vraiment par empreinte, et surtout `updateMany` honore
 * vraiment sa condition `WHERE … IS NULL`. C'est indispensable ici — le
 * caractère « une seule fois par compte » du crédit de bienvenue **repose**
 * sur cette condition. Des mocks à réponses pré-programmées ne prouveraient
 * rien du tout.
 */
class FakeStore {
  readonly users = new Map<string, UserRow>();
  readonly suppressions: SuppressionRow[] = [];

  readonly user = {
    findUnique: jest.fn(
      ({
        where,
      }: {
        where: { id?: string; emailVerificationTokenHash?: string };
      }) => Promise.resolve(this.findUser(where) ?? null),
    ),

    update: jest.fn(
      ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const row = this.users.get(where.id);
        if (!row) {
          throw new Error(`Utilisateur inconnu : ${where.id}`);
        }
        Object.assign(row, data);
        return Promise.resolve(row);
      },
    ),

    // Le point clé : la condition est appliquée, pas ignorée.
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: {
          id: string;
          emailVerifiedAt?: null;
        };
        data: Partial<UserRow>;
      }) => {
        const row = this.users.get(where.id);

        if (
          !row ||
          ('emailVerifiedAt' in where && row.emailVerifiedAt !== null)
        ) {
          return Promise.resolve({ count: 0 });
        }

        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      },
    ),
  };

  readonly suppression = {
    findFirst: jest.fn(
      ({
        where,
      }: {
        where: { address: string; OR: { userId: string | null }[] };
      }) => {
        const allowed = where.OR.map((clause) => clause.userId);
        const hit = this.suppressions.find(
          (row) =>
            row.address === where.address && allowed.includes(row.userId),
        );

        return Promise.resolve(hit ? { id: 'sup_1' } : null);
      },
    ),
  };

  readonly $transaction = jest.fn(
    (run: (tx: FakeStore) => Promise<unknown>): Promise<unknown> => run(this),
  );

  private findUser(where: {
    id?: string;
    emailVerificationTokenHash?: string;
  }): UserRow | undefined {
    if (where.id !== undefined) {
      return this.users.get(where.id);
    }

    return [...this.users.values()].find(
      (row) =>
        row.emailVerificationTokenHash !== null &&
        row.emailVerificationTokenHash === where.emailVerificationTokenHash,
    );
  }
}

/** Extrait le jeton en clair du lien contenu dans l'email expédié. */
function tokenFromPayload(payload: SystemEmailPayload): string {
  const match = /[?&]token=([^"&\s<]+)/.exec(payload.text ?? '');

  if (!match) {
    throw new Error("Aucun jeton dans le corps de l'email");
  }

  return decodeURIComponent(match[1]);
}

describe('EmailConfirmationService', () => {
  let service: EmailConfirmationService;
  let store: FakeStore;

  const sendSystem = jest.fn();
  const configValues: Record<string, string> = {
    FRONTEND_ORIGIN: 'https://zendou.dev',
  };

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    store = new FakeStore();
    store.users.set(USER_ID, {
      id: USER_ID,
      email: USER_EMAIL,
      name: USER_NAME,
      emailVerifiedAt: null,
      emailVerificationTokenHash: null,
      emailVerificationSentTo: null,
      emailVerificationExpiresAt: null,
    });
    sendSystem.mockResolvedValue({ status: 'queued', id: 'e_abc' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailConfirmationService,
        { provide: PrismaService, useValue: store },
        { provide: EmailsService, useValue: { sendSystem } },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => configValues[key] },
        },
      ],
    }).compile();

    service = module.get(EmailConfirmationService);
  });

  /** Émet un jeton et retourne sa valeur en clair, comme le ferait l'email. */
  async function issue(): Promise<string> {
    await service.issueAndSend(USER_ID, USER_EMAIL, USER_NAME);

    const [payload] = sendSystem.mock.calls.at(-1) as [SystemEmailPayload];
    return tokenFromPayload(payload);
  }

  function row(): UserRow {
    return store.users.get(USER_ID) as UserRow;
  }

  describe('émission du jeton', () => {
    it('expédie un lien construit sur la configuration, jamais en dur', async () => {
      const token = await issue();

      const [payload] = sendSystem.mock.calls[0] as [SystemEmailPayload];

      expect(payload.userId).toBe(USER_ID);
      expect(payload.to).toBe(USER_EMAIL);
      expect(payload.text).toContain(
        `https://zendou.dev/confirmation?token=${encodeURIComponent(token)}`,
      );
      expect(payload.html).toContain('/confirmation?token=');
    });

    it('préfère APP_BASE_URL à FRONTEND_ORIGIN quand elle est renseignée', async () => {
      configValues.APP_BASE_URL = 'https://app.zendou.dev/';

      const token = await issue();
      const [payload] = sendSystem.mock.calls[0] as [SystemEmailPayload];

      expect(payload.text).toContain(
        `https://app.zendou.dev/confirmation?token=${encodeURIComponent(token)}`,
      );

      delete configValues.APP_BASE_URL;
    });

    it('ne stocke que l’empreinte SHA-256 du jeton, jamais sa valeur', async () => {
      const token = await issue();
      const stored = row();

      expect(stored.emailVerificationTokenHash).toBe(
        createHash('sha256').update(token).digest('hex'),
      );
      expect(stored.emailVerificationTokenHash).not.toBe(token);

      // Aucune colonne du compte ne contient le jeton en clair.
      expect(JSON.stringify(stored)).not.toContain(token);
    });

    it('pose une expiration à 24 heures et retient l’adresse visée', async () => {
      const ttlMs = EMAIL_CONFIRMATION_TTL_HOURS * 3_600_000;

      const before = Date.now();
      await issue();
      const after = Date.now();

      const stored = row();
      const expiresAt = (stored.emailVerificationExpiresAt as Date).getTime();

      // Encadrement strict : l'expiration est posée pendant l'appel, elle vaut
      // donc « instant de l'écriture + TTL », à la durée de l'appel près.
      expect(expiresAt).toBeGreaterThanOrEqual(before + ttlMs);
      expect(expiresAt).toBeLessThanOrEqual(after + ttlMs);
      expect(stored.emailVerificationSentTo).toBe(USER_EMAIL);
    });

    it('un renvoi périme le jeton précédent (un seul lien vivant)', async () => {
      const first = await issue();
      const second = await issue();

      expect(second).not.toBe(first);
      await expect(service.confirm(first)).rejects.toThrow(BadRequestException);
      await expect(service.confirm(second)).resolves.toMatchObject({
        confirmed: true,
      });
    });
  });

  describe('confirmation', () => {
    it('confirme le compte et répond confirmed: true', async () => {
      const token = await issue();

      await expect(service.confirm(token)).resolves.toEqual({
        confirmed: true,
        creditsGranted: 0,
      });

      expect(row().emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('rejeu du même jeton : 409 (usage unique)', async () => {
      const token = await issue();

      await service.confirm(token);
      await expect(service.confirm(token)).rejects.toThrow(
        new ConflictException(ALREADY_CONFIRMED_MESSAGE),
      );
    });

    it('jeton expiré : 400', async () => {
      const token = await issue();
      row().emailVerificationExpiresAt = new Date(Date.now() - 1_000);

      await expect(service.confirm(token)).rejects.toThrow(
        new BadRequestException(INVALID_CONFIRMATION_TOKEN_MESSAGE),
      );
      expect(row().emailVerifiedAt).toBeNull();
    });

    it('jeton inconnu : 400', async () => {
      await expect(service.confirm('jeton-qui-nexiste-pas')).rejects.toThrow(
        new BadRequestException(INVALID_CONFIRMATION_TOKEN_MESSAGE),
      );
    });

    it('compte déjà confirmé : 409', async () => {
      const token = await issue();
      row().emailVerifiedAt = new Date('2026-01-01T00:00:00.000Z');

      await expect(service.confirm(token)).rejects.toThrow(
        new ConflictException(ALREADY_CONFIRMED_MESSAGE),
      );
    });

    /**
     * L'invariant n'est pas confié au code qui change l'adresse — il est porté
     * par la donnée : le jeton mémorise l'adresse pour laquelle il a été émis,
     * et n'est accepté que si elle est toujours celle du compte.
     */
    it('changement d’adresse email : l’ancien jeton ne marche plus', async () => {
      const token = await issue();

      row().email = 'nouvelle-adresse@example.com';

      await expect(service.confirm(token)).rejects.toThrow(
        new BadRequestException(INVALID_CONFIRMATION_TOKEN_MESSAGE),
      );
      expect(row().emailVerifiedAt).toBeNull();
    });
  });

  describe('renvoi du lien', () => {
    it('émet un nouveau jeton et répond sent: true', async () => {
      await expect(service.resend(USER_ID)).resolves.toEqual({ sent: true });

      expect(sendSystem).toHaveBeenCalledTimes(1);
      expect(row().emailVerificationTokenHash).not.toBeNull();
    });

    it('compte déjà confirmé : 409, et rien n’est expédié', async () => {
      row().emailVerifiedAt = new Date();

      await expect(service.resend(USER_ID)).rejects.toThrow(
        new ConflictException(ALREADY_CONFIRMED_MESSAGE),
      );
      expect(sendSystem).not.toHaveBeenCalled();
    });

    /**
     * Le piège n°1 : la liste de suppression s'applique aussi aux emails
     * système. Répondre « envoyé » ferait attendre indéfiniment un email qui
     * ne partira jamais.
     */
    it('adresse en liste de suppression : 422, aucun email mis en file', async () => {
      store.suppressions.push({ address: USER_EMAIL, userId: USER_ID });

      await expect(service.resend(USER_ID)).rejects.toThrow(
        new UnprocessableEntityException(SUPPRESSED_ADDRESS_MESSAGE),
      );
      expect(sendSystem).not.toHaveBeenCalled();
      // Le jeton en cours n'est pas invalidé par un renvoi qui ne part pas.
      expect(row().emailVerificationTokenHash).toBeNull();
    });

    it('suppression globale (userId nul) : 422 également', async () => {
      store.suppressions.push({ address: USER_EMAIL, userId: null });

      await expect(service.resend(USER_ID)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(sendSystem).not.toHaveBeenCalled();
    });

    it('expédition impossible : 503, jamais un sent: true mensonger', async () => {
      sendSystem.mockRejectedValue(new Error('SYSTEM_EMAIL_FROM absente'));

      await expect(service.resend(USER_ID)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  it('hashConfirmationToken est le SHA-256 hex du jeton, comme pour les clés API', () => {
    expect(hashConfirmationToken('abc')).toBe(
      createHash('sha256').update('abc').digest('hex'),
    );
  });
});

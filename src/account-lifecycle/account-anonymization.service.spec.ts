import {
  ConflictException,
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminActionType, UserRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { ApiKeyAuthGuard } from '../api-keys/api-key-auth.guard';
import { SecretHashingService } from '../api-keys/secret-hashing.service';
import { INVALID_CREDENTIALS_MESSAGE } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { DomainsService } from '../domains/domains.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisThrottlerStorage } from '../rate-limit/redis-throttler.storage';
import { SmtpAuthService } from '../smtp/smtp-auth.service';
import type { SessionService } from '../auth/session.service';
import type { EmailConfirmationService } from '../auth/email-confirmation.service';
import type { LoginLockoutService } from '../auth/login-lockout.service';
import { AccountAnonymizationService } from './account-anonymization.service';
import {
  ADMIN_ANONYMIZE_MESSAGE,
  ALREADY_ANONYMIZED_MESSAGE,
  ANONYMIZED_FOR_INACTIVITY_REASON,
  ANONYMIZED_NAME,
  ANONYMIZED_ON_REQUEST_REASON,
  SELF_ANONYMIZE_MESSAGE,
} from './account-lifecycle.constants';
import { InMemoryPrisma } from './fixtures/in-memory-prisma';

const ORIGINAL_EMAIL = 'awa.diallo@boutique-awa.gn';
const ORIGINAL_NAME = 'Awa Diallo';
const PASSWORD = 'mot-de-passe-solide-42';
const API_KEY = 'zd_live_cleDeTestAnonymisation0123456789';
const SMTP_USERNAME = 'zdu_0123456789abcdef';
const SMTP_SECRET = 'zd_smtp_secretDeTestAnonymisation0123';
const GOOGLE_SUB = 'google-sub-awa';

const config = new ConfigService({});
const hashing = new SecretHashingService(config);

/**
 * Compte client complet : tout ce qu'un compte réel possède après quelques
 * mois d'usage (domaines, clé, identifiant SMTP, envois, recharge, crédits,
 * jeton de confirmation, Google), plus un second compte témoin qui ne doit
 * pas bouger.
 */
async function seedAccount(db: InMemoryPrisma) {
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const created = new Date('2026-01-10T00:00:00.000Z');

  db.seed('user', {
    id: 'admin_1',
    email: 'admin@zendou.app',
    name: 'Admin',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    anonymizedAt: null,
    createdAt: created,
  });
  db.seed('user', {
    id: 'u1',
    email: ORIGINAL_EMAIL,
    name: ORIGINAL_NAME,
    company: 'Boutique Awa',
    declaredUsage: 'Factures et relances',
    passwordHash,
    googleSub: GOOGLE_SUB,
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    dailySendLimit: 500,
    emailVerifiedAt: created,
    emailVerificationTokenHash: 'hash-jeton',
    emailVerificationSentTo: ORIGINAL_EMAIL,
    emailVerificationExpiresAt: created,
    welcomeCreditsGrantedAt: created,
    lastActivityAt: created,
    inactivityWarningSentAt: null,
    anonymizedAt: null,
    suspendedAt: null,
    suspensionReason: null,
    createdAt: created,
  });
  db.seed('user', {
    id: 'witness',
    email: 'temoin@exemple.gn',
    name: 'Témoin',
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    anonymizedAt: null,
    createdAt: created,
  });

  db.seed('domain', { id: 'd1', userId: 'u1', name: 'boutique-awa.gn' });
  db.seed('domain', { id: 'd2', userId: 'u1', name: 'mail.boutique-awa.gn' });
  db.seed('domain', { id: 'dw', userId: 'witness', name: 'temoin.gn' });
  db.seed('apiKey', {
    id: 'k1',
    userId: 'u1',
    keyHash: hashing.hashForStorage(API_KEY),
    revokedAt: null,
  });
  db.seed('apiKey', {
    id: 'kw',
    userId: 'witness',
    keyHash: 'x',
    revokedAt: null,
  });
  db.seed('smtpCredential', {
    id: 's1',
    userId: 'u1',
    username: SMTP_USERNAME,
    secretHash: hashing.hashForStorage(SMTP_SECRET),
    revokedAt: null,
  });
  db.seed('email', {
    id: 'e1',
    userId: 'u1',
    toAddress: 'client1@x.gn',
    system: false,
  });
  db.seed('email', {
    id: 'e2',
    userId: 'u1',
    toAddress: 'client2@x.gn',
    system: false,
    smtpCredentialId: 's1',
  });
  db.seed('email', {
    id: 'e3',
    userId: 'u1',
    toAddress: ORIGINAL_EMAIL,
    system: true,
  });
  db.seed('email', {
    id: 'ew',
    userId: 'witness',
    toAddress: 'a@b.gn',
    system: false,
  });
  db.seed('creditEntry', {
    id: 'c1',
    userId: 'u1',
    delta: 1000,
    reason: 'WELCOME_BONUS',
    reference: null,
  });
  db.seed('creditEntry', {
    id: 'c2',
    userId: 'u1',
    delta: 15000,
    reason: 'TOPUP',
    reference: 't1',
  });
  db.seed('creditEntry', {
    id: 'c3',
    userId: 'u1',
    delta: -1,
    reason: 'SEND',
    reference: 'pub_e1',
  });
  db.seed('topUpRequest', {
    id: 't1',
    userId: 'u1',
    packId: 'starter',
    credits: 15000,
    amountGnf: 50000,
    method: 'ORANGE_MONEY',
    phoneNumber: '+224620000000',
    transactionRef: 'OM-123',
    status: 'APPROVED',
  });
  db.seed('suppression', {
    id: 'sup1',
    address: ORIGINAL_EMAIL,
    userId: 'u1',
    reason: 'HARD_BOUNCE',
  });
  db.seed('adminAction', {
    id: 'aa0',
    adminId: 'admin_1',
    targetUserId: 'u1',
    type: AdminActionType.ADJUST_QUOTA,
    reason: null,
    details: { dailySendLimit: 500 },
  });
}

describe('AccountAnonymizationService', () => {
  let db: InMemoryPrisma;
  let destroyAllForUser: jest.Mock;
  let deleteSesIdentity: jest.Mock;
  let service: AccountAnonymizationService;

  beforeEach(async () => {
    db = new InMemoryPrisma();
    await seedAccount(db);
    destroyAllForUser = jest.fn().mockResolvedValue(undefined);
    deleteSesIdentity = jest.fn().mockResolvedValue(undefined);
    service = new AccountAnonymizationService(
      db as unknown as PrismaService,
      { destroyAllForUser } as unknown as SessionService,
      { deleteSesIdentity } as unknown as DomainsService,
    );
  });

  const admin = { kind: 'admin', adminId: 'admin_1' } as const;
  const rowsOf = (table: keyof InMemoryPrisma['tables'], userId: string) =>
    db.tables[table].filter((row) => row.userId === userId);

  describe('nominal', () => {
    it('efface les données personnelles du compte, champ par champ', async () => {
      const result = await service.anonymize('u1', admin);

      const user = db.tables.user.find((row) => row.id === 'u1')!;
      expect(user.email).toBe('anonymise-u1@anonymise.invalid');
      expect(user.name).toBe(ANONYMIZED_NAME);
      expect(user.company).toBeNull();
      expect(user.declaredUsage).toBeNull();
      expect(user.passwordHash).toBeNull();
      expect(user.googleSub).toBeNull();
      expect(user.emailVerificationTokenHash).toBeNull();
      expect(user.emailVerificationSentTo).toBeNull();
      expect(user.emailVerificationExpiresAt).toBeNull();
      expect(user.status).toBe(UserStatus.SUSPENDED);
      expect(user.suspensionReason).toBe(ANONYMIZED_ON_REQUEST_REASON);
      expect(user.anonymizedAt).toEqual(result!.anonymizedAt);
      expect(user.suspendedAt).toEqual(result!.anonymizedAt);
      // Conservés : non personnels, utiles à la lecture des traces.
      expect(user.role).toBe(UserRole.CUSTOMER);
      expect(user.createdAt).toEqual(new Date('2026-01-10T00:00:00.000Z'));
      expect(result!.remainingActions).toEqual([]);
    });

    it('supprime domaines, clés API, identifiants SMTP et tous les emails du compte', async () => {
      await service.anonymize('u1', admin);

      expect(rowsOf('domain', 'u1')).toEqual([]);
      expect(rowsOf('apiKey', 'u1')).toEqual([]);
      expect(rowsOf('smtpCredential', 'u1')).toEqual([]);
      // Envois client ET email système : adresses de destinataires.
      expect(rowsOf('email', 'u1')).toEqual([]);
    });

    it('conserve à l’identique les traces de paiement (CreditEntry, TopUpRequest)', async () => {
      const before = db.snapshot();

      await service.anonymize('u1', admin);

      expect(rowsOf('creditEntry', 'u1')).toEqual(
        before.creditEntry.filter((row) => row.userId === 'u1'),
      );
      expect(rowsOf('creditEntry', 'u1')).toHaveLength(3);
      expect(rowsOf('topUpRequest', 'u1')).toEqual(
        before.topUpRequest.filter((row) => row.userId === 'u1'),
      );
    });

    it('conserve la ligne de suppression et le journal d’audit antérieur', async () => {
      await service.anonymize('u1', admin);

      expect(db.tables.suppression).toHaveLength(1);
      expect(
        db.tables.adminAction.find((row) => row.id === 'aa0'),
      ).toBeDefined();
    });

    it('ne touche à aucune donnée d’un autre compte', async () => {
      const before = db.snapshot();

      await service.anonymize('u1', admin);

      for (const table of Object.keys(before) as Array<keyof typeof before>) {
        const others = (rows: Array<Record<string, unknown>>) =>
          rows.filter(
            (row) =>
              row.userId === 'witness' ||
              row.id === 'witness' ||
              row.id === 'admin_1',
          );
        expect(others(db.tables[table])).toEqual(others(before[table]));
      }
    });

    it('détruit l’identité SES de chaque domaine, par le chemin de suppression des domaines', async () => {
      await service.anonymize('u1', admin);

      expect(deleteSesIdentity.mock.calls).toEqual([
        ['boutique-awa.gn'],
        ['mail.boutique-awa.gn'],
      ]);
    });

    it('révoque toutes les sessions du compte', async () => {
      await service.anonymize('u1', admin);

      expect(destroyAllForUser).toHaveBeenCalledWith('u1');
    });

    it('journalise ANONYMIZE_USER avec l’id et la date, sans l’email ni le nom d’origine', async () => {
      const result = await service.anonymize('u1', admin);

      const action = db.tables.adminAction.find(
        (row) => row.type === AdminActionType.ANONYMIZE_USER,
      )!;
      expect(action).toMatchObject({ adminId: 'admin_1', targetUserId: 'u1' });
      expect(action.details).toEqual({
        anonymizedUserId: 'u1',
        anonymizedAt: result!.anonymizedAt.toISOString(),
      });
      const journal = JSON.stringify(db.tables.adminAction);
      expect(journal).not.toContain(ORIGINAL_EMAIL);
      expect(journal).not.toContain(ORIGINAL_NAME);
    });
  });

  describe('refus', () => {
    it('refuse en 409 un admin qui s’anonymise lui-même, sans rien écrire', async () => {
      db.seed('user', {
        id: 'admin_2',
        email: 'a2@zendou.app',
        name: 'A2',
        role: UserRole.CUSTOMER,
        anonymizedAt: null,
      });
      const before = db.snapshot();

      await expect(
        service.anonymize('admin_2', { kind: 'admin', adminId: 'admin_2' }),
      ).rejects.toThrow(new ConflictException(SELF_ANONYMIZE_MESSAGE));
      expect(db.tables).toEqual(before);
    });

    it('refuse en 409 un compte ADMIN, avec un message explicite', async () => {
      db.seed('user', {
        id: 'admin_3',
        email: 'a3@zendou.app',
        name: 'A3',
        role: UserRole.ADMIN,
        anonymizedAt: null,
      });
      const before = db.snapshot();

      await expect(service.anonymize('admin_3', admin)).rejects.toThrow(
        new ConflictException(ADMIN_ANONYMIZE_MESSAGE),
      );
      expect(db.tables).toEqual(before);
    });

    it('refuse en 409 un compte déjà anonymisé', async () => {
      await service.anonymize('u1', admin);
      const before = db.snapshot();

      await expect(service.anonymize('u1', admin)).rejects.toThrow(
        new ConflictException(ALREADY_ANONYMIZED_MESSAGE),
      );
      expect(db.tables).toEqual(before);
    });

    it('répond 404 pour un compte inconnu', async () => {
      await expect(service.anonymize('inconnu', admin)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('nettoyage externe en échec', () => {
    it('signale l’identité SES non détruite au lieu d’échouer en silence', async () => {
      deleteSesIdentity.mockImplementation((name: string) =>
        name === 'boutique-awa.gn'
          ? Promise.reject(new Error('Throttling: Rate exceeded'))
          : Promise.resolve(),
      );

      const result = await service.anonymize('u1', admin);

      expect(result!.remainingActions).toHaveLength(1);
      expect(result!.remainingActions[0]).toContain('boutique-awa.gn');
      expect(result!.remainingActions[0]).toContain(
        'Throttling: Rate exceeded',
      );
      // La base est anonymisée quand même, et l'autre domaine traité.
      expect(
        db.tables.user.find((row) => row.id === 'u1')!.anonymizedAt,
      ).not.toBeNull();
      expect(deleteSesIdentity).toHaveBeenCalledWith('mail.boutique-awa.gn');
      expect(destroyAllForUser).toHaveBeenCalledWith('u1');
    });

    it('signale une révocation des sessions en échec', async () => {
      destroyAllForUser.mockRejectedValue(new Error('Redis indisponible'));

      const result = await service.anonymize('u1', admin);

      expect(result!.remainingActions).toEqual([
        expect.stringContaining('Redis indisponible'),
      ]);
    });
  });

  describe('origine « inactivité »', () => {
    const cutoffs = {
      kind: 'inactivity',
      inactiveSince: new Date('2026-02-01T00:00:00.000Z'),
      warnedBefore: new Date('2026-02-01T00:00:00.000Z'),
    } as const;

    it('anonymise un compte éligible, sans ligne d’audit, avec le motif d’inactivité', async () => {
      const user = db.tables.user.find((row) => row.id === 'u1')!;
      user.inactivityWarningSentAt = new Date('2026-01-15T00:00:00.000Z');

      const result = await service.anonymize('u1', cutoffs);

      expect(result).not.toBeNull();
      expect(user.suspensionReason).toBe(ANONYMIZED_FOR_INACTIVITY_REASON);
      expect(user.inactivityWarningSentAt).toBeNull();
      expect(
        db.tables.adminAction.filter(
          (row) => row.type === AdminActionType.ANONYMIZE_USER,
        ),
      ).toEqual([]);
    });

    it('épargne un compte sans avertissement, sans rien écrire', async () => {
      const before = db.snapshot();

      await expect(service.anonymize('u1', cutoffs)).resolves.toBeNull();
      expect(db.tables).toEqual(before);
      expect(destroyAllForUser).not.toHaveBeenCalled();
    });

    it('épargne un compte redevenu actif depuis la recherche', async () => {
      const user = db.tables.user.find((row) => row.id === 'u1')!;
      user.inactivityWarningSentAt = new Date('2026-01-15T00:00:00.000Z');
      user.lastActivityAt = new Date('2026-03-01T00:00:00.000Z');
      const before = db.snapshot();

      await expect(service.anonymize('u1', cutoffs)).resolves.toBeNull();
      expect(db.tables).toEqual(before);
    });

    it('ignore un ADMIN sans lever', async () => {
      await expect(service.anonymize('admin_1', cutoffs)).resolves.toBeNull();
    });
  });

  /**
   * Après anonymisation, le compte ne peut plus entrer par aucun des quatre
   * chemins : mot de passe, Google, clé API, identifiant SMTP. Les vrais
   * services d'authentification sont montés sur la même base en mémoire.
   */
  describe('plus aucune connexion possible', () => {
    const lockout = {
      assertNotLocked: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
    };
    let sessionCreate: jest.Mock;
    let authService: AuthService;

    beforeEach(() => {
      sessionCreate = jest.fn().mockResolvedValue('jeton');
      authService = new AuthService(
        db as unknown as PrismaService,
        {
          create: sessionCreate,
          destroyAllForUser,
        } as unknown as SessionService,
        {
          grantWelcomeCredits: jest.fn().mockResolvedValue(undefined),
          markVerified: jest.fn().mockResolvedValue(undefined),
        } as unknown as EmailConfirmationService,
        config,
        lockout as unknown as LoginLockoutService,
      );
    });

    function httpContext(headers: Record<string, string>) {
      const request = {
        headers,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        cookies: {},
      };
      return {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({ setHeader: jest.fn() }),
        }),
      } as unknown as ExecutionContext;
    }

    it('témoin : avant anonymisation, les quatre chemins aboutissent', async () => {
      await expect(
        authService.login({ email: ORIGINAL_EMAIL, password: PASSWORD }),
      ).resolves.toMatchObject({ user: { id: 'u1' } });
      await expect(
        authService.loginWithGoogle({
          sub: GOOGLE_SUB,
          email: ORIGINAL_EMAIL,
          name: ORIGINAL_NAME,
        }),
      ).resolves.toMatchObject({ user: { id: 'u1' } });
      const guard = new ApiKeyAuthGuard(
        db as unknown as PrismaService,
        config,
        {
          increment: jest.fn().mockResolvedValue({ isBlocked: false }),
        } as unknown as RedisThrottlerStorage,
        hashing,
      );
      await expect(
        guard.canActivate(httpContext({ authorization: `Bearer ${API_KEY}` })),
      ).resolves.toBe(true);
      const smtp = new SmtpAuthService(db as unknown as PrismaService, config);
      await expect(
        smtp.authenticate(SMTP_USERNAME, SMTP_SECRET, '127.0.0.1'),
      ).resolves.toMatchObject({ user: { id: 'u1' } });
    });

    it('mot de passe : refusé (401), aucune session ouverte', async () => {
      await service.anonymize('u1', admin);

      await expect(
        authService.login({ email: ORIGINAL_EMAIL, password: PASSWORD }),
      ).rejects.toThrow(UnauthorizedException);
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it('adresse de remplacement : réponse générique, sans oracle « compte Google »', async () => {
      await service.anonymize('u1', admin);

      await expect(
        authService.login({
          email: 'anonymise-u1@anonymise.invalid',
          password: PASSWORD,
        }),
      ).rejects.toThrow(new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE));
      expect(sessionCreate).not.toHaveBeenCalled();
    });

    it('Google : jamais de session pour le compte anonymisé (un nouveau compte distinct est créé)', async () => {
      await service.anonymize('u1', admin);

      const result = await authService.loginWithGoogle({
        sub: GOOGLE_SUB,
        email: ORIGINAL_EMAIL,
        name: ORIGINAL_NAME,
      });

      expect(result.user.id).not.toBe('u1');
      expect(sessionCreate).not.toHaveBeenCalledWith('u1');
      expect(
        db.tables.user.find((row) => row.id === 'u1')!.googleSub,
      ).toBeNull();
    });

    it('clé API : refusée (401)', async () => {
      await service.anonymize('u1', admin);
      const guard = new ApiKeyAuthGuard(
        db as unknown as PrismaService,
        config,
        {
          increment: jest.fn().mockResolvedValue({ isBlocked: false }),
        } as unknown as RedisThrottlerStorage,
        hashing,
      );

      await expect(
        guard.canActivate(httpContext({ authorization: `Bearer ${API_KEY}` })),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('identifiant SMTP : refusé', async () => {
      await service.anonymize('u1', admin);
      const smtp = new SmtpAuthService(db as unknown as PrismaService, config);

      await expect(
        smtp.authenticate(SMTP_USERNAME, SMTP_SECRET, '127.0.0.1'),
      ).rejects.toBeDefined();
    });

    it('session antérieure non indexée : refusée en 403 (compte suspendu)', async () => {
      await service.anonymize('u1', admin);
      const guard = new SessionAuthGuard(
        {
          resolve: jest.fn().mockResolvedValue('u1'),
        } as unknown as SessionService,
        db as unknown as PrismaService,
        config,
      );
      const context = httpContext({ cookie: 'zendou_session=ancien' });
      const request = context
        .switchToHttp()
        .getRequest<{ cookies: Record<string, string> }>();
      request.cookies = { zendou_session: 'ancien' };

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        status: 403,
      });
    });
  });
});

import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthService } from '../auth/auth.service';
import type { EmailConfirmationService } from '../auth/email-confirmation.service';
import type { LoginLockoutService } from '../auth/login-lockout.service';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { SessionService } from '../auth/session.service';
import type { PrismaService } from '../prisma/prisma.service';
import { recordAccountActivity } from './account-activity';
import { InMemoryPrisma } from './fixtures/in-memory-prisma';

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-09-25T12:00:00.000Z');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function seedUser(db: InMemoryPrisma, overrides: Record<string, unknown> = {}) {
  return db.seed('user', {
    id: 'u1',
    email: 'awa@boutique-awa.gn',
    name: 'Awa',
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    passwordHash: null,
    googleSub: null,
    company: null,
    declaredUsage: null,
    dailySendLimit: 200,
    emailVerifiedAt: NOW,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastActivityAt: new Date('2026-06-01T00:00:00.000Z'),
    inactivityWarningSentAt: null,
    anonymizedAt: null,
    ...overrides,
  });
}

describe('recordAccountActivity', () => {
  let db: InMemoryPrisma;

  beforeEach(() => {
    db = new InMemoryPrisma();
  });

  it('écrit la date et lève l’avertissement d’inactivité', async () => {
    const user = seedUser(db, {
      inactivityWarningSentAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    await expect(recordAccountActivity(db, 'u1', NOW)).resolves.toBe(true);

    expect(user.lastActivityAt).toEqual(NOW);
    expect(user.inactivityWarningSentAt).toBeNull();
  });

  it('écrit quand aucune activité n’est connue', async () => {
    const user = seedUser(db, { lastActivityAt: null });

    await expect(recordAccountActivity(db, 'u1', NOW)).resolves.toBe(true);
    expect(user.lastActivityAt).toEqual(NOW);
  });

  it('au plus une écriture par heure : la base refuse la seconde', async () => {
    const user = seedUser(db);

    await recordAccountActivity(db, 'u1', NOW);
    const later = new Date(NOW.getTime() + HOUR_MS - 1);
    await expect(recordAccountActivity(db, 'u1', later)).resolves.toBe(false);
    expect(user.lastActivityAt).toEqual(NOW);

    const nextHour = new Date(NOW.getTime() + HOUR_MS);
    await expect(recordAccountActivity(db, 'u1', nextHour)).resolves.toBe(true);
    expect(user.lastActivityAt).toEqual(nextHour);
  });

  it('aucune requête quand l’appelant connaît une activité de moins d’une heure', async () => {
    seedUser(db);
    const updateMany = jest.spyOn(db.user, 'updateMany');

    await expect(
      recordAccountActivity(
        db,
        'u1',
        NOW,
        new Date(NOW.getTime() - HOUR_MS + 1),
      ),
    ).resolves.toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ne touche jamais un compte anonymisé', async () => {
    const user = seedUser(db, { anonymizedAt: NOW, lastActivityAt: null });

    await expect(recordAccountActivity(db, 'u1', NOW)).resolves.toBe(false);
    expect(user.lastActivityAt).toBeNull();
  });
});

describe('enregistrement de l’activité, câblage réel', () => {
  let db: InMemoryPrisma;
  const config = new ConfigService({});

  beforeEach(() => {
    db = new InMemoryPrisma();
  });

  it('connexion par mot de passe : activité enregistrée, avertissement levé', async () => {
    const user = seedUser(db, {
      passwordHash: await argon2.hash('mot-de-passe-42', {
        type: argon2.argon2id,
      }),
      lastActivityAt: new Date('2024-10-01T00:00:00.000Z'),
      inactivityWarningSentAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const auth = new AuthService(
      db as unknown as PrismaService,
      {
        create: jest.fn().mockResolvedValue('jeton'),
      } as unknown as SessionService,
      {} as EmailConfirmationService,
      config,
      {
        assertNotLocked: jest.fn(),
        recordFailure: jest.fn(),
        recordSuccess: jest.fn(),
      } as unknown as LoginLockoutService,
    );

    await auth.login({
      email: 'awa@boutique-awa.gn',
      password: 'mot-de-passe-42',
    });
    await flush();

    expect((user.lastActivityAt as Date).getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00.000Z').getTime(),
    );
    expect(user.inactivityWarningSentAt).toBeNull();
  });

  it('connexion Google : activité enregistrée', async () => {
    const user = seedUser(db, {
      googleSub: 'sub-awa',
      lastActivityAt: new Date('2024-10-01T00:00:00.000Z'),
    });
    const auth = new AuthService(
      db as unknown as PrismaService,
      {
        create: jest.fn().mockResolvedValue('jeton'),
      } as unknown as SessionService,
      {} as EmailConfirmationService,
      config,
      {} as LoginLockoutService,
    );

    await auth.loginWithGoogle({
      sub: 'sub-awa',
      email: 'awa@boutique-awa.gn',
      name: 'Awa',
    });
    await flush();

    expect((user.lastActivityAt as Date).getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00.000Z').getTime(),
    );
  });

  it('session : dix requêtes dans l’heure, une seule écriture, et lastActivityAt absent de request.user', async () => {
    seedUser(db, { lastActivityAt: new Date('2026-06-01T00:00:00.000Z') });
    const updateMany = jest.spyOn(db.user, 'updateMany');
    const guard = new SessionAuthGuard(
      {
        resolve: jest.fn().mockResolvedValue('u1'),
      } as unknown as SessionService,
      db as unknown as PrismaService,
      config,
    );
    const request: Record<string, unknown> = {
      cookies: { zendou_session: 'jeton' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    for (let i = 0; i < 10; i += 1) {
      await guard.canActivate(context);
      await flush();
    }

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(request.user).not.toHaveProperty('lastActivityAt');
  });
});

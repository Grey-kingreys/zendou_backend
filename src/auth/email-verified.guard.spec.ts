import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserRole, UserStatus } from '@prisma/client';
import { ApiKeysController } from '../api-keys/api-keys.controller';
import { EmailsController } from '../emails/emails.controller';
import { ApiKeyAuthGuard } from '../api-keys';
import type { AuthUser } from './auth.types';
import { EMAIL_NOT_VERIFIED_MESSAGE } from './email-confirmation.constants';
import { EmailVerifiedGuard } from './email-verified.guard';

function userWith(emailVerifiedAt: Date | null | undefined): AuthUser {
  return {
    id: 'user_1',
    email: 'aissatou@example.com',
    name: 'Aïssatou Diallo',
    company: null,
    declaredUsage: null,
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    emailVerifiedAt,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function contextWith(user: AuthUser | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('EmailVerifiedGuard', () => {
  const guard = new EmailVerifiedGuard();

  it('laisse passer un compte confirmé', () => {
    expect(
      guard.canActivate(
        contextWith(userWith(new Date('2026-02-01T10:00:00.000Z'))),
      ),
    ).toBe(true);
  });

  it('refuse un compte non confirmé avec un 403 en français', () => {
    expect(() => guard.canActivate(contextWith(userWith(null)))).toThrow(
      new ForbiddenException(EMAIL_NOT_VERIFIED_MESSAGE),
    );
  });

  /**
   * Fermeture par défaut : un `AuthUser` construit sans le champ (fixture, ou
   * futur appelant qui n'aurait pas utilisé `AUTH_USER_SELECT`) ne doit pas
   * ouvrir la porte par accident.
   */
  it('refuse aussi quand emailVerifiedAt est absent, et quand il n’y a pas d’utilisateur', () => {
    expect(() => guard.canActivate(contextWith(userWith(undefined)))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(contextWith(undefined))).toThrow(
      ForbiddenException,
    );
  });
});

describe('Surfaces fermées aux comptes non confirmés', () => {
  it("POST /v1/emails porte le garde, après l'authentification par clé API", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, EmailsController)).toEqual([
      ApiKeyAuthGuard,
      EmailVerifiedGuard,
    ]);
  });

  it('la création de clé API porte le garde', () => {
    const create = Object.getOwnPropertyDescriptor(
      ApiKeysController.prototype,
      'create',
    )?.value as (...args: unknown[]) => unknown;

    expect(Reflect.getMetadata(GUARDS_METADATA, create)).toEqual([
      EmailVerifiedGuard,
    ]);
  });

  /**
   * L'exact complément du test précédent : reprendre la main sur ses clés
   * (lister, révoquer, purger, régénérer) reste possible sans confirmation.
   * Ces gestes ne créent aucune capacité d'envoi ; les fermer enfermerait un
   * compte non confirmé avec des clés qu'il ne pourrait plus révoquer.
   */
  it.each(['findAll', 'revoke', 'purge', 'rotate'])(
    'la route %s reste ouverte',
    (method) => {
      const handler = Object.getOwnPropertyDescriptor(
        ApiKeysController.prototype,
        method,
      )?.value as (...args: unknown[]) => unknown;

      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    },
  );
});

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus } from '@prisma/client';
import { recordAccountActivity } from '../account-lifecycle/account-activity';
import { PrismaService } from '../prisma/prisma.service';
import {
  AUTH_USER_RECORD_SELECT,
  AuthenticatedRequest,
  toAuthUser,
} from './auth.types';
import { readSessionCookie } from './session-cookie';
import { SessionService } from './session.service';
import { resolveTestSenderAddress } from './test-sender-address';

/**
 * Authentifie la requête à partir du cookie de session.
 * - 401 si le cookie est absent, la session expirée ou l'utilisateur supprimé
 * - 403 si le compte est suspendu
 * En cas de succès, `request.user` contient l'utilisateur courant.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly sessionService: SessionService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readSessionCookie(request);

    if (!token) {
      throw new UnauthorizedException('Authentification requise');
    }

    const userId = await this.sessionService.resolve(token);

    if (!userId) {
      throw new UnauthorizedException('Session invalide ou expirée');
    }

    const found = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...AUTH_USER_RECORD_SELECT, lastActivityAt: true },
    });

    if (!found) {
      // Session orpheline : l'utilisateur n'existe plus.
      await this.sessionService.destroy(token);
      throw new UnauthorizedException('Session invalide ou expirée');
    }

    // `lastActivityAt` ne sort jamais dans `request.user` (donc ni dans
    // `GET /v1/auth/me`) : il ne sert qu'à l'enregistrement d'activité.
    const { lastActivityAt, ...selected } = found;

    if (selected.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('Ce compte est suspendu');
    }

    // Une session utilisée est une connexion (ANON-1) : une session
    // glissante peut vivre des mois sans nouveau login, son titulaire n'est
    // pas inactif pour autant. Aucune requête si l'activité connue a moins
    // d'une heure ; sinon une écriture, hors du chemin critique.
    void recordAccountActivity(
      this.prisma,
      selected.id,
      new Date(),
      lastActivityAt,
    ).catch(() => undefined);

    // `testSenderAddress` n'est pas une colonne Prisma : voir la
    // documentation de `AuthUser.testSenderAddress` (`auth.types.ts`). C'est
    // ce chemin qui alimente `GET /v1/auth/me`.
    request.user = toAuthUser(
      selected,
      resolveTestSenderAddress(this.configService),
    );
    request.sessionToken = token;

    return true;
  }
}

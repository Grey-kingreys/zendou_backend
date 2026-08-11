import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AUTH_USER_SELECT, AuthenticatedRequest } from './auth.types';
import { readSessionCookie } from './session-cookie';
import { SessionService } from './session.service';

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

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: AUTH_USER_SELECT,
    });

    if (!user) {
      // Session orpheline : l'utilisateur n'existe plus.
      await this.sessionService.destroy(token);
      throw new UnauthorizedException('Session invalide ou expirée');
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('Ce compte est suspendu');
    }

    request.user = user;
    request.sessionToken = token;

    return true;
  }
}

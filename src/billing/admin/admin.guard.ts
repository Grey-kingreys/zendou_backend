import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AuthenticatedRequest } from '../../auth';
import { SessionAuthGuard } from '../../auth';
import { ADMIN_FORBIDDEN_MESSAGE } from '../billing.constants';

/**
 * Authentifie via `SessionAuthGuard` (401 si absent/expiré/suspendu) puis
 * exige le rôle ADMIN (403 sinon). Les routes admin n'ont donc besoin que
 * de ce seul garde.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly sessionAuthGuard: SessionAuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.sessionAuthGuard.canActivate(context);

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (request.user?.role !== UserRole.ADMIN) {
      throw new ForbiddenException(ADMIN_FORBIDDEN_MESSAGE);
    }

    return true;
  }
}

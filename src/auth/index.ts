export { AuthModule } from './auth.module';
export { AuthService } from './auth.service';
export type { AuthResult } from './auth.service';
export { SessionService } from './session.service';
export { SessionAuthGuard } from './session-auth.guard';
export { CurrentUser } from './current-user.decorator';
export {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  SESSION_REDIS,
} from './auth.constants';
export { AUTH_USER_SELECT } from './auth.types';
export type { AuthUser, AuthenticatedRequest } from './auth.types';

import type { Request } from 'express';
import type { UserRole, UserStatus } from '@prisma/client';

/**
 * Représentation publique d'un utilisateur authentifié.
 * Ne contient jamais le `passwordHash`.
 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  company: string | null;
  declaredUsage: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
}

/**
 * Sélection Prisma correspondant exactement à `AuthUser`.
 * Le `satisfies` garantit qu'aucun champ ne peut diverger de l'interface.
 */
export const AUTH_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  company: true,
  declaredUsage: true,
  role: true,
  status: true,
  createdAt: true,
} satisfies Record<keyof AuthUser, true>;

/** Requête Express enrichie par le `SessionAuthGuard`. */
export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  sessionToken?: string;
}

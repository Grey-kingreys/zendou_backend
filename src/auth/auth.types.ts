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
  /**
   * Optionnel au niveau du type (et non `number` strict) uniquement pour ne
   * pas casser la compilation des fixtures `AuthUser` déjà écrites dans les
   * specs d'autres modules (domains, reputation, api-keys, billing,
   * emails-log…) qui construisent un utilisateur authentifié minimal sans
   * ce champ. En pratique il est toujours présent : `AUTH_USER_SELECT` le
   * sélectionne systématiquement, donc `GET`/`PATCH /v1/auth/me` le
   * renvoient toujours dans le JSON réel.
   */
  dailySendLimit?: number;
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
  dailySendLimit: true,
  createdAt: true,
} satisfies Record<keyof AuthUser, true>;

/** Requête Express enrichie par le `SessionAuthGuard`. */
export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  sessionToken?: string;
}

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
  /**
   * Date de confirmation de l'adresse email, `null` tant qu'elle ne l'est
   * pas. Exposée telle quelle par `GET`/`PATCH /v1/auth/me` (sérialisée en
   * chaîne ISO), et lue par `EmailVerifiedGuard`.
   *
   * Optionnelle au niveau du type pour la même raison que `dailySendLimit` :
   * ne pas casser la compilation des fixtures `AuthUser` déjà écrites dans
   * les specs des autres modules. En pratique elle est toujours présente,
   * `AUTH_USER_SELECT` la sélectionnant systématiquement. `EmailVerifiedGuard`
   * traite l'absence comme « non confirmé » : en cas de doute on ferme.
   */
  emailVerifiedAt?: Date | null;
  createdAt: Date;
  /**
   * Adresse d'expédition du mode bac à sable (`TEST_EMAIL_FROM`, voir B20 /
   * V11A), sous forme nue — voir `resolveTestSenderAddress`
   * (`test-sender-address.ts`) pour le détail du choix de format. `null` si
   * `TEST_EMAIL_FROM` n'est pas configurée.
   *
   * À la différence de `dailySendLimit`/`emailVerifiedAt`, ce champ ne vient
   * **pas** d'une colonne Prisma : il n'existe rien à sélectionner en base,
   * c'est pourquoi `AUTH_USER_SELECT` ci-dessous l'exclut explicitement. Il
   * est calculé à partir de `ConfigService` et fusionné dans l'objet à
   * chaque endroit qui construit un `AuthUser` complet (`AuthService.register`
   * / `.login` / `.updateProfile`, `SessionAuthGuard`, `ApiKeyAuthGuard`) —
   * voir `resolveTestSenderAddress`.
   *
   * Optionnel au niveau du type pour la même raison que les deux champs
   * ci-dessus : ne pas casser la compilation des fixtures `AuthUser` déjà
   * écrites dans les specs d'autres modules qui construisent un utilisateur
   * authentifié minimal sans ce champ. En pratique il est toujours présent :
   * `GET`/`PATCH /v1/auth/me` le renvoient toujours (`null` si
   * `TEST_EMAIL_FROM` n'est pas configurée, jamais `undefined`).
   */
  testSenderAddress?: string | null;
}

/**
 * Sélection Prisma correspondant exactement à `AuthUser`, à l'exception de
 * `testSenderAddress` : ce champ ne vient pas de la base (voir sa
 * documentation ci-dessus), donc il n'a pas sa place dans un `select`
 * Prisma — l'ajouter ferait échouer la requête (colonne inexistante). Le
 * `satisfies` garantit malgré tout qu'aucun champ *réellement issu de la
 * base* ne peut diverger de l'interface.
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
  emailVerifiedAt: true,
  createdAt: true,
} satisfies Record<Exclude<keyof AuthUser, 'testSenderAddress'>, true>;

/** Requête Express enrichie par le `SessionAuthGuard`. */
export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  sessionToken?: string;
}

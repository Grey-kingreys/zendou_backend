import type { Request } from 'express';
import type { UserRole, UserStatus } from '@prisma/client';

/**
 * Représentation publique d'un utilisateur authentifié.
 * Ne contient jamais le `passwordHash` ni le `googleSub`.
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
   * / `.login` / `.updateProfile`, `SessionAuthGuard`, `ApiKeyAuthGuard`,
   * `SmtpAuthService`), via `toAuthUser` - voir `resolveTestSenderAddress`.
   *
   * Optionnel au niveau du type pour la même raison que les deux champs
   * ci-dessus : ne pas casser la compilation des fixtures `AuthUser` déjà
   * écrites dans les specs d'autres modules qui construisent un utilisateur
   * authentifié minimal sans ce champ. En pratique il est toujours présent :
   * `GET`/`PATCH /v1/auth/me` le renvoient toujours (`null` si
   * `TEST_EMAIL_FROM` n'est pas configurée, jamais `undefined`).
   */
  testSenderAddress?: string | null;
  /**
   * `true` si le compte a un mot de passe (B30). Un compte créé par
   * « Continuer avec Google » n'en a pas : le front adapte alors l'écran de
   * profil. Dérivé de `passwordHash`, qui lui n'est **jamais** exposé.
   *
   * Optionnel au niveau du type pour la même raison que les champs
   * ci-dessus ; toujours présent en pratique (voir `toAuthUser`).
   */
  hasPassword?: boolean;
  /**
   * `true` si le compte est rattaché à un compte Google (B30). Dérivé de
   * `googleSub`, qui lui n'est **jamais** exposé. Même remarque de typage.
   */
  googleLinked?: boolean;
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
} satisfies Record<
  Exclude<keyof AuthUser, 'testSenderAddress' | 'hasPassword' | 'googleLinked'>,
  true
>;

/**
 * Sélection des sites qui construisent un `AuthUser` complet : les colonnes
 * de `AUTH_USER_SELECT`, plus les deux colonnes dont on ne publie que la
 * présence (`hasPassword`, `googleLinked`). Le résultat ne doit jamais sortir
 * tel quel : il passe par `toAuthUser`, qui retire `passwordHash` et
 * `googleSub`.
 */
export const AUTH_USER_RECORD_SELECT = {
  ...AUTH_USER_SELECT,
  passwordHash: true,
  googleSub: true,
} as const;

/** Ligne lue avec `AUTH_USER_RECORD_SELECT`. */
export type AuthUserRecord = Omit<
  AuthUser,
  'testSenderAddress' | 'hasPassword' | 'googleLinked'
> & {
  passwordHash: string | null;
  googleSub: string | null;
};

/**
 * Construit l'`AuthUser` public à partir d'une ligne `AUTH_USER_RECORD_SELECT`.
 * `passwordHash` et `googleSub` sont retirés ici, et seulement leur présence
 * est publiée. `testSenderAddress` vient de la configuration (voir
 * `resolveTestSenderAddress`).
 */
export function toAuthUser(
  record: AuthUserRecord,
  testSenderAddress: string | null,
): AuthUser {
  const { passwordHash, googleSub, ...selected } = record;

  return {
    ...selected,
    testSenderAddress,
    // `typeof` plutôt que `!== null` : une colonne absente de la ligne (select
    // incomplet) ne doit jamais se lire comme « présente ».
    hasPassword: typeof passwordHash === 'string',
    googleLinked: typeof googleSub === 'string',
  };
}

/** Requête Express enrichie par le `SessionAuthGuard`. */
export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  sessionToken?: string;
}

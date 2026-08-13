/** Pagination de `GET /v1/admin/users` — mêmes bornes que les autres listes. */
export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/** Bornes des motifs saisis par l'admin (suspension, réactivation, crédit). */
export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 300;

/** Bornes du quota journalier ajustable à la main. */
export const MIN_DAILY_SEND_LIMIT = 1;
export const MAX_DAILY_SEND_LIMIT = 1_000_000;

/** Borne d'un avoir/débit administratif, positif comme négatif. */
export const MAX_CREDIT_DELTA = 1_000_000;

/** Nombre d'actions d'audit remontées par le détail d'un compte. */
export const RECENT_ACTIONS_LIMIT = 10;

/** Valeur inscrite dans `CreditEntry.reason` pour un mouvement admin. */
export const CREDIT_REASON_ADMIN_GRANT = 'ADMIN_GRANT';

export const USER_NOT_FOUND_MESSAGE = 'Utilisateur introuvable.';
export const USER_ALREADY_SUSPENDED_MESSAGE = 'Ce compte est déjà suspendu.';
export const USER_ALREADY_ACTIVE_MESSAGE = 'Ce compte est déjà actif.';

export const SELF_SUSPEND_MESSAGE =
  'Un administrateur ne peut pas suspendre son propre compte : demandez à un autre administrateur.';
export const SELF_CREDIT_MESSAGE =
  'Un administrateur ne peut pas créditer son propre compte : demandez à un autre administrateur.';
export const SELF_DELETE_MESSAGE =
  'Un administrateur ne peut pas supprimer son propre compte : demandez à un autre administrateur.';

/**
 * Encadrent la liste des compteurs dans le message 409 de
 * `AdminUsersService.deleteUser` — voir `buildDeleteBlockers`. Un seul
 * message concaténé plutôt que des constantes par cause : le nombre et
 * l'ordre des causes possibles ne sont pas fixes (de 1 à 6 items).
 */
export const DELETE_BLOCKED_MESSAGE_PREFIX =
  'Suppression refusée : ce compte possède encore ';
export const DELETE_BLOCKED_MESSAGE_SUFFIX =
  '. Suspendez le compte plutôt que de le supprimer.';

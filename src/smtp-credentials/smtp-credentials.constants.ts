/** Message renvoyé quand un identifiant SMTP n'existe pas ou n'appartient pas au user courant. */
export const SMTP_CREDENTIAL_NOT_FOUND_MESSAGE = 'Identifiant SMTP introuvable';

/** Message renvoyé quand on tente de supprimer un identifiant SMTP encore actif. */
export const SMTP_CREDENTIAL_NOT_REVOKED_MESSAGE =
  'Seul un identifiant SMTP déjà révoqué peut être supprimé. Révoquez-le au préalable.';

/** Message renvoyé quand on tente de régénérer un identifiant SMTP révoqué. */
export const SMTP_CREDENTIAL_ROTATE_REVOKED_MESSAGE =
  'Un identifiant SMTP révoqué ne peut pas être régénéré.';

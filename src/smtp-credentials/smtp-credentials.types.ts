import type { CredentialScopeView } from '../domains/credential-scope';

/** Réponse à la création d'un identifiant SMTP : le mot de passe complet n'apparaît qu'ici. */
export interface CreateSmtpCredentialResponse extends CredentialScopeView {
  id: string;
  name: string;
  username: string;
  prefix: string;
  password: string;
  createdAt: Date;
}

/** Élément de la liste des identifiants SMTP d'un utilisateur (jamais `secretHash`). */
export interface SmtpCredentialSummary extends CredentialScopeView {
  id: string;
  name: string;
  username: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Réponse à la rotation d'un identifiant SMTP : le nouveau mot de passe
 * complet n'apparaît qu'ici. `id`, `name`, `username` et `createdAt` sont
 * inchangés par rapport à l'identifiant d'origine ; `prefix` et la valeur
 * secrète sont nouveaux.
 */
export interface RotateSmtpCredentialResponse {
  id: string;
  name: string;
  username: string;
  prefix: string;
  password: string;
  createdAt: Date;
  rotatedAt: Date;
}

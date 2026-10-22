import type { AuthenticatedRequest } from '../auth';
import type { CredentialScopeView } from '../domains/credential-scope';

/** Réponse à la création d'une clé API : la clé complète n'apparaît qu'ici. */
export interface CreateApiKeyResponse extends CredentialScopeView {
  id: string;
  name: string;
  prefix: string;
  /** Autorisation de lecture (journal des envois, domaines), immuable. */
  canRead: boolean;
  key: string;
  createdAt: Date;
}

/** Élément de la liste des clés API d'un utilisateur (jamais `keyHash`). */
export interface ApiKeySummary extends CredentialScopeView {
  id: string;
  name: string;
  prefix: string;
  canRead: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Réponse à la rotation d'une clé API : la nouvelle clé complète n'apparaît
 * qu'ici. `id`, `name` et `createdAt` sont inchangés par rapport à la clé
 * d'origine ; `prefix` et la valeur secrète sont nouveaux.
 */
export interface RotateApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  key: string;
  createdAt: Date;
  rotatedAt: Date;
}

/** Requête Express enrichie par `ApiKeyAuthGuard`. */
export interface ApiKeyAuthenticatedRequest extends AuthenticatedRequest {
  apiKeyId?: string;
  /** Autorisation de lecture de la clé authentifiée (`ApiKey.canRead`). */
  apiKeyCanRead?: boolean;
}

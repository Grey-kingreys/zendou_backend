import type { AuthenticatedRequest } from '../auth';

/** Réponse à la création d'une clé API : la clé complète n'apparaît qu'ici. */
export interface CreateApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  key: string;
  createdAt: Date;
}

/** Élément de la liste des clés API d'un utilisateur (jamais `keyHash`). */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
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
}

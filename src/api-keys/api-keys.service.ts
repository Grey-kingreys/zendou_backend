import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  API_KEY_NOT_FOUND_MESSAGE,
  API_KEY_NOT_REVOKED_MESSAGE,
  API_KEY_ROTATE_REVOKED_MESSAGE,
} from './api-keys.constants';
import { generateApiKey } from './api-key.utils';
import {
  ApiKeySummary,
  CreateApiKeyResponse,
  RotateApiKeyResponse,
} from './api-keys.types';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { SecretHashingService } from './secret-hashing.service';
import {
  resolveCredentialScope,
  SCOPE_SELECT,
  toScopeDomains,
} from '../domains/credential-scope';

/**
 * E7 - la propriété est établie **dans la requête** (`findFirst` filtre sur
 * `{ id, userId }`), jamais par une comparaison JavaScript sur une ligne
 * chargée par identifiant seul. La différence n'est pas cosmétique : une
 * lecture par `id` seul rend la ligne d'autrui au processus, et il ne reste
 * qu'un `if` entre elle et la réponse - un `if` qu'une refonte peut déplacer,
 * oublier ou court-circuiter. Ici, la base ne rend simplement rien.
 *
 * Les `update`/`delete` qui suivent ciblent toujours l'`id` seul : la
 * propriété est déjà établie à ce point.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secretHashing: SecretHashingService,
  ) {}

  /**
   * Génère une nouvelle clé API pour l'utilisateur.
   * La clé complète n'est renvoyée qu'ici : seule son empreinte est stockée
   * (HMAC poivré quand `API_KEY_PEPPER` est configurée, SHA-256 sinon - voir
   * `SecretHashingService`).
   */
  async create(
    userId: string,
    dto: CreateApiKeyDto,
  ): Promise<CreateApiKeyResponse> {
    const scope = await resolveCredentialScope(
      this.prisma,
      userId,
      dto.domainIds,
    );
    const generated = generateApiKey();

    const apiKey = await this.prisma.apiKey.create({
      data: {
        userId,
        name: dto.name.trim(),
        prefix: generated.prefix,
        keyHash: this.secretHashing.hashForStorage(generated.key),
        domainScope: scope.domainScope,
        domains: {
          create: scope.domainIds.map((domainId) => ({ domainId })),
        },
      },
      select: {
        id: true,
        name: true,
        prefix: true,
        createdAt: true,
        ...SCOPE_SELECT,
      },
    });

    const { domains, ...rest } = apiKey;

    return { ...rest, domains: toScopeDomains(domains), key: generated.key };
  }

  /** Liste les clés API de l'utilisateur courant, sans jamais exposer `keyHash`. */
  async findAllForUser(userId: string): Promise<ApiKeySummary[]> {
    const apiKeys = await this.prisma.apiKey.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        prefix: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
        ...SCOPE_SELECT,
      },
      orderBy: { createdAt: 'desc' },
    });

    return apiKeys.map(({ domains, ...rest }) => ({
      ...rest,
      domains: toScopeDomains(domains),
    }));
  }

  /**
   * Révocation douce d'une clé API : la ligne reste, `revokedAt` est posé.
   * Idempotent (aucune erreur si la clé est déjà révoquée).
   * 404 si la clé n'existe pas ou n'appartient pas à `userId`.
   */
  async revoke(userId: string, id: string): Promise<void> {
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { id, userId },
      select: { id: true, revokedAt: true },
    });

    if (!apiKey) {
      throw new NotFoundException(API_KEY_NOT_FOUND_MESSAGE);
    }

    if (apiKey.revokedAt) {
      return;
    }

    await this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Suppression définitive d'une clé API : la ligne disparaît de la base.
   * Autorisée uniquement pour une clé déjà révoquée, afin qu'on ne puisse
   * jamais faire disparaître d'un seul geste une clé active et sa trace
   * (`lastUsedAt`). 404 si la clé n'existe pas ou n'appartient pas à
   * `userId` ; 409 si elle est encore active.
   */
  async purge(userId: string, id: string): Promise<void> {
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { id, userId },
      select: { id: true, revokedAt: true },
    });

    if (!apiKey) {
      throw new NotFoundException(API_KEY_NOT_FOUND_MESSAGE);
    }

    if (!apiKey.revokedAt) {
      throw new ConflictException(API_KEY_NOT_REVOKED_MESSAGE);
    }

    await this.prisma.apiKey.delete({ where: { id } });
  }

  /**
   * Rotation d'une clé API : régénère le secret sur place (même `id`, même
   * `name`, même `createdAt`) avec un nouveau `prefix` et un nouveau
   * `keyHash`. Coupure immédiate — l'ancienne valeur cesse de fonctionner dès
   * l'écriture, il n'y a pas de période de grâce. `rotatedAt` trace le geste.
   * 404 si la clé n'existe pas ou n'appartient pas à `userId` ; 409 si elle
   * est révoquée (une clé morte ne se régénère pas).
   */
  async rotate(userId: string, id: string): Promise<RotateApiKeyResponse> {
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { id, userId },
      select: {
        id: true,
        name: true,
        createdAt: true,
        revokedAt: true,
      },
    });

    if (!apiKey) {
      throw new NotFoundException(API_KEY_NOT_FOUND_MESSAGE);
    }

    if (apiKey.revokedAt) {
      throw new ConflictException(API_KEY_ROTATE_REVOKED_MESSAGE);
    }

    const generated = generateApiKey();
    const rotatedAt = new Date();

    await this.prisma.apiKey.update({
      where: { id },
      data: {
        prefix: generated.prefix,
        keyHash: this.secretHashing.hashForStorage(generated.key),
        rotatedAt,
      },
    });

    return {
      id: apiKey.id,
      name: apiKey.name,
      prefix: generated.prefix,
      key: generated.key,
      createdAt: apiKey.createdAt,
      rotatedAt,
    };
  }
}

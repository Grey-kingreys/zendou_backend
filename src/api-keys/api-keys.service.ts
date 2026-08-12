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

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Génère une nouvelle clé API pour l'utilisateur.
   * La clé complète n'est renvoyée qu'ici : seul son hash SHA-256 est stocké.
   */
  async create(
    userId: string,
    dto: CreateApiKeyDto,
  ): Promise<CreateApiKeyResponse> {
    const generated = generateApiKey();

    const apiKey = await this.prisma.apiKey.create({
      data: {
        userId,
        name: dto.name.trim(),
        prefix: generated.prefix,
        keyHash: generated.keyHash,
      },
      select: { id: true, name: true, prefix: true, createdAt: true },
    });

    return { ...apiKey, key: generated.key };
  }

  /** Liste les clés API de l'utilisateur courant, sans jamais exposer `keyHash`. */
  async findAllForUser(userId: string): Promise<ApiKeySummary[]> {
    return this.prisma.apiKey.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        prefix: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Révocation douce d'une clé API : la ligne reste, `revokedAt` est posé.
   * Idempotent (aucune erreur si la clé est déjà révoquée).
   * 404 si la clé n'existe pas ou n'appartient pas à `userId`.
   */
  async revoke(userId: string, id: string): Promise<void> {
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id },
      select: { id: true, userId: true, revokedAt: true },
    });

    if (!apiKey || apiKey.userId !== userId) {
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
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id },
      select: { id: true, userId: true, revokedAt: true },
    });

    if (!apiKey || apiKey.userId !== userId) {
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
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        name: true,
        createdAt: true,
        revokedAt: true,
      },
    });

    if (!apiKey || apiKey.userId !== userId) {
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
        keyHash: generated.keyHash,
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

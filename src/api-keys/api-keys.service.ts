import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { API_KEY_NOT_FOUND_MESSAGE } from './api-keys.constants';
import { generateApiKey } from './api-key.utils';
import { ApiKeySummary, CreateApiKeyResponse } from './api-keys.types';
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
}

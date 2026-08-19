import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  SMTP_CREDENTIAL_NOT_FOUND_MESSAGE,
  SMTP_CREDENTIAL_NOT_REVOKED_MESSAGE,
  SMTP_CREDENTIAL_ROTATE_REVOKED_MESSAGE,
} from './smtp-credentials.constants';
import {
  generateSmtpCredentialSecret,
  generateSmtpCredentialUsername,
} from './smtp-credential.utils';
import {
  CreateSmtpCredentialResponse,
  RotateSmtpCredentialResponse,
  SmtpCredentialSummary,
} from './smtp-credentials.types';
import { CreateSmtpCredentialDto } from './dto/create-smtp-credential.dto';

/**
 * Cycle de vie des identifiants SMTP — calqué ligne à ligne sur
 * `ApiKeysService` (§3.2/§3.3 du plan B6) : même sémantique de révocation
 * idempotente, purge réservée aux identifiants révoqués, rotation à
 * coupure immédiate sans période de grâce. Aucune sémantique nouvelle à
 * apprendre pour le client qui connaît déjà les clés API.
 */
@Injectable()
export class SmtpCredentialsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Génère un nouvel identifiant SMTP pour l'utilisateur.
   * Le mot de passe complet n'est renvoyé qu'ici : seul son hash SHA-256
   * est stocké (`secretHash`), et le nom d'utilisateur est opaque et généré.
   */
  async create(
    userId: string,
    dto: CreateSmtpCredentialDto,
  ): Promise<CreateSmtpCredentialResponse> {
    const generated = generateSmtpCredentialSecret();
    const username = generateSmtpCredentialUsername();

    const credential = await this.prisma.smtpCredential.create({
      data: {
        userId,
        name: dto.name.trim(),
        username,
        prefix: generated.prefix,
        secretHash: generated.passwordHash,
      },
      select: {
        id: true,
        name: true,
        username: true,
        prefix: true,
        createdAt: true,
      },
    });

    return { ...credential, password: generated.password };
  }

  /** Liste les identifiants SMTP de l'utilisateur courant, sans jamais exposer `secretHash`. */
  async findAllForUser(userId: string): Promise<SmtpCredentialSummary[]> {
    return this.prisma.smtpCredential.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        username: true,
        prefix: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Révocation douce d'un identifiant SMTP : la ligne reste, `revokedAt` est
   * posé. Idempotent (aucune erreur si l'identifiant est déjà révoqué).
   * 404 si l'identifiant n'existe pas ou n'appartient pas à `userId`.
   */
  async revoke(userId: string, id: string): Promise<void> {
    const credential = await this.prisma.smtpCredential.findUnique({
      where: { id },
      select: { id: true, userId: true, revokedAt: true },
    });

    if (!credential || credential.userId !== userId) {
      throw new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE);
    }

    if (credential.revokedAt) {
      return;
    }

    await this.prisma.smtpCredential.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Suppression définitive d'un identifiant SMTP : la ligne disparaît de la
   * base. Autorisée uniquement pour un identifiant déjà révoqué, afin qu'on
   * ne puisse jamais faire disparaître d'un seul geste un identifiant actif
   * et sa trace (`lastUsedAt`). 404 si l'identifiant n'existe pas ou
   * n'appartient pas à `userId` ; 409 s'il est encore actif.
   */
  async purge(userId: string, id: string): Promise<void> {
    const credential = await this.prisma.smtpCredential.findUnique({
      where: { id },
      select: { id: true, userId: true, revokedAt: true },
    });

    if (!credential || credential.userId !== userId) {
      throw new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE);
    }

    if (!credential.revokedAt) {
      throw new ConflictException(SMTP_CREDENTIAL_NOT_REVOKED_MESSAGE);
    }

    await this.prisma.smtpCredential.delete({ where: { id } });
  }

  /**
   * Rotation d'un identifiant SMTP : régénère le secret sur place (même
   * `id`, même `name`, même `username`, même `createdAt`) avec un nouveau
   * `prefix` et un nouveau `secretHash`. Coupure immédiate — l'ancien mot de
   * passe cesse de fonctionner dès l'écriture, il n'y a pas de période de
   * grâce. `rotatedAt` trace le geste. 404 si l'identifiant n'existe pas ou
   * n'appartient pas à `userId` ; 409 s'il est révoqué (un identifiant mort
   * ne se régénère pas).
   */
  async rotate(
    userId: string,
    id: string,
  ): Promise<RotateSmtpCredentialResponse> {
    const credential = await this.prisma.smtpCredential.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        name: true,
        username: true,
        createdAt: true,
        revokedAt: true,
      },
    });

    if (!credential || credential.userId !== userId) {
      throw new NotFoundException(SMTP_CREDENTIAL_NOT_FOUND_MESSAGE);
    }

    if (credential.revokedAt) {
      throw new ConflictException(SMTP_CREDENTIAL_ROTATE_REVOKED_MESSAGE);
    }

    const generated = generateSmtpCredentialSecret();
    const rotatedAt = new Date();

    await this.prisma.smtpCredential.update({
      where: { id },
      data: {
        prefix: generated.prefix,
        secretHash: generated.passwordHash,
        rotatedAt,
      },
    });

    return {
      id: credential.id,
      name: credential.name,
      username: credential.username,
      prefix: generated.prefix,
      password: generated.password,
      createdAt: credential.createdAt,
      rotatedAt,
    };
  }
}

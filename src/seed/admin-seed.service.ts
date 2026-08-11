import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, UserRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Crée le compte administrateur au démarrage de l'application s'il n'existe
 * pas déjà, à partir de `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME`.
 *
 * Objectif : sur un déploiement neuf, l'admin doit pouvoir valider les
 * demandes de recharge Mobile Money dès la première minute, sans script
 * manuel ni CLI de seed séparée.
 *
 * Règles :
 * - sans configuration → no-op (log et retour) ;
 * - compte déjà existant → jamais de modification du mot de passe (le
 *   propriétaire doit pouvoir le changer sans qu'un redémarrage l'écrase) ;
 *   seule promotion autorisée : CUSTOMER → ADMIN ;
 * - une erreur du seed (y compris une course P2002 entre deux instances qui
 *   démarrent en même temps) ne doit jamais empêcher l'application de
 *   démarrer.
 */
@Injectable()
export class AdminSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminSeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seedAdmin();
    } catch (error) {
      this.logger.error(
        "Échec du seed du compte admin — l'application démarre tout de même",
        error instanceof Error ? error.stack : error,
      );
    }
  }

  private async seedAdmin(): Promise<void> {
    const rawEmail = this.configService.get<string>('ADMIN_EMAIL');
    const password = this.configService.get<string>('ADMIN_PASSWORD');

    if (!rawEmail || !password) {
      this.logger.log('seed admin ignoré (ADMIN_EMAIL non configuré)');
      return;
    }

    const name =
      this.configService.get<string>('ADMIN_NAME') ?? 'Administrateur Zendou';
    const email = normalizeEmail(rawEmail);

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true },
    });

    if (existing) {
      if (existing.role !== UserRole.ADMIN) {
        await this.prisma.user.update({
          where: { id: existing.id },
          data: { role: UserRole.ADMIN },
        });
        this.logger.warn(
          `compte existant promu ADMIN (était ${existing.role}) : ${email}`,
        );
      } else {
        this.logger.log('compte admin déjà présent');
      }
      return;
    }

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
    });

    try {
      await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          name,
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
        },
      });
      this.logger.log(`compte admin créé : ${email}`);
    } catch (error) {
      // Course entre deux instances qui démarrent en même temps et tentent
      // toutes les deux de créer le même compte admin.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.logger.log(
          'compte admin déjà créé par une autre instance (P2002)',
        );
        return;
      }
      throw error;
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

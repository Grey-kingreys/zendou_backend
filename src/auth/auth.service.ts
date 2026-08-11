import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import {
  EMAIL_ALREADY_USED_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  NO_CHANGES_MESSAGE,
  SAME_PASSWORD_MESSAGE,
  WRONG_CURRENT_PASSWORD_MESSAGE,
} from './auth.constants';
import { AUTH_USER_SELECT, AuthUser } from './auth.types';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SessionService } from './session.service';

export interface AuthResult {
  user: AuthUser;
  token: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  /** Crée un utilisateur, hache son mot de passe et ouvre une session. */
  async register(dto: RegisterDto): Promise<AuthResult> {
    const email = normalizeEmail(dto.email);

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(EMAIL_ALREADY_USED_MESSAGE);
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    let user: AuthUser;

    try {
      user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          name: dto.name.trim(),
          company: dto.company ?? null,
          declaredUsage: dto.declaredUsage ?? null,
        },
        select: AUTH_USER_SELECT,
      });
    } catch (error) {
      // Course entre deux inscriptions simultanées sur la même adresse.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(EMAIL_ALREADY_USED_MESSAGE);
      }
      throw error;
    }

    const token = await this.sessionService.create(user.id);

    return { user, token };
  }

  /** Vérifie les identifiants et ouvre une session. */
  async login(dto: LoginDto): Promise<AuthResult> {
    const email = normalizeEmail(dto.email);

    const record = await this.prisma.user.findUnique({
      where: { email },
      select: { ...AUTH_USER_SELECT, passwordHash: true },
    });

    if (!record) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const { passwordHash, ...user } = record;

    if (!(await this.verifyPassword(passwordHash, dto.password))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const token = await this.sessionService.create(user.id);

    return { user, token };
  }

  /**
   * Met à jour partiellement le profil (`name` / `company` / `declaredUsage`).
   * `company` et `declaredUsage` acceptent `''` ou `null` pour effacer la
   * valeur existante. Au moins un champ doit être fourni (l'email, jamais
   * modifiable ici, est déjà retiré en amont par le `ValidationPipe`).
   */
  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<AuthUser> {
    const hasChanges =
      dto.name !== undefined ||
      dto.company !== undefined ||
      dto.declaredUsage !== undefined;

    if (!hasChanges) {
      throw new BadRequestException(NO_CHANGES_MESSAGE);
    }

    const data: Prisma.UserUpdateInput = {};

    if (dto.name !== undefined) {
      data.name = dto.name.trim();
    }

    if (dto.company !== undefined) {
      data.company = dto.company === '' ? null : dto.company;
    }

    if (dto.declaredUsage !== undefined) {
      data.declaredUsage = dto.declaredUsage === '' ? null : dto.declaredUsage;
    }

    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: AUTH_USER_SELECT,
    });
  }

  /**
   * Change le mot de passe, puis révoque **toutes** les sessions de
   * l'utilisateur (voir `SessionService.destroyAllForUser`).
   *
   * Choix de sécurité : un changement de mot de passe est souvent motivé
   * par la suspicion (ou la confirmation) qu'un tiers connaît l'ancien mot
   * de passe ou a dérobé un cookie de session. Continuer à faire confiance
   * à des sessions ouvertes avant le changement — y compris la session
   * courante — annulerait l'intérêt de l'opération. On révoque donc tout et
   * on laisse le contrôleur effacer le cookie du navigateur courant : le
   * client (légitime) devra se reconnecter avec le nouveau mot de passe.
   */
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (
      !user ||
      !(await this.verifyPassword(user.passwordHash, dto.currentPassword))
    ) {
      throw new UnauthorizedException(WRONG_CURRENT_PASSWORD_MESSAGE);
    }

    if (await this.verifyPassword(user.passwordHash, dto.newPassword)) {
      throw new BadRequestException(SAME_PASSWORD_MESSAGE);
    }

    const passwordHash = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    await this.sessionService.destroyAllForUser(userId);
  }

  private async verifyPassword(
    passwordHash: string,
    password: string,
  ): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      // Hash corrompu ou format inconnu : échec silencieux, message générique.
      return false;
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

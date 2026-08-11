import {
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
} from './auth.constants';
import { AUTH_USER_SELECT, AuthUser } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
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

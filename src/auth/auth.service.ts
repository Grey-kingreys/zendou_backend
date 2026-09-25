import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import {
  EMAIL_ALREADY_USED_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  NO_CHANGES_MESSAGE,
  PASSWORD_NOT_SET_CHANGE_MESSAGE,
  PASSWORD_NOT_SET_CODE,
  PASSWORD_NOT_SET_LOGIN_MESSAGE,
  SAME_PASSWORD_MESSAGE,
  WRONG_CURRENT_PASSWORD_MESSAGE,
} from './auth.constants';
import { AUTH_USER_RECORD_SELECT, AuthUser, toAuthUser } from './auth.types';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { EmailConfirmationService } from './email-confirmation.service';
import { GOOGLE_ERROR } from './google-oauth.constants';
import { GoogleAuthError, type GoogleIdentity } from './google-oauth.service';
import { LoginLockoutService } from './login-lockout.service';
import { SessionService } from './session.service';
import { resolveTestSenderAddress } from './test-sender-address';

export interface AuthResult {
  user: AuthUser;
  token: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
    private readonly emailConfirmation: EmailConfirmationService,
    private readonly configService: ConfigService,
    private readonly loginLockout: LoginLockoutService,
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
      const created = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          name: dto.name.trim(),
          company: dto.company ?? null,
          declaredUsage: dto.declaredUsage ?? null,
        },
        select: AUTH_USER_RECORD_SELECT,
      });
      // `testSenderAddress` n'est pas une colonne Prisma : voir la
      // documentation de `AuthUser.testSenderAddress` (`auth.types.ts`).
      user = toAuthUser(created, resolveTestSenderAddress(this.configService));
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

    // Émission et expédition du lien de confirmation, hors du chemin critique
    // de l'inscription : une panne SES, une file Redis indisponible ou une
    // adresse d'expédition mal configurée ne doivent pas faire échouer la
    // création d'un compte déjà écrit en base. Le compte reste non confirmé,
    // et l'utilisateur dispose de `POST /v1/auth/resend-confirmation`.
    void this.emailConfirmation
      .issueAndSend(user.id, user.email, user.name)
      .catch((error: unknown) => {
        this.logger.error(
          `Envoi du lien de confirmation en échec pour l'utilisateur ${user.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    const token = await this.sessionService.create(user.id);

    return { user, token };
  }

  /** Vérifie les identifiants et ouvre une session. */
  async login(dto: LoginDto): Promise<AuthResult> {
    const email = normalizeEmail(dto.email);

    // Avant la base et avant argon2 : une adresse déjà verrouillée ne doit
    // plus rien coûter au serveur, et surtout pas un hachage argon2id de
    // plusieurs dizaines de millisecondes par tentative.
    await this.loginLockout.assertNotLocked(email);

    const record = await this.prisma.user.findUnique({
      where: { email },
      select: AUTH_USER_RECORD_SELECT,
    });

    if (!record) {
      // Email inconnu compté exactement comme un mot de passe faux : la
      // différence de traitement serait, à elle seule, un oracle d'existence
      // de compte.
      await this.loginLockout.recordFailure(email);
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    if (record.passwordHash === null) {
      // Compte sans mot de passe (B30) : ni argon2, ni échec compté au
      // verrouillage. Il n'y a aucun mot de passe à deviner, et compter
      // l'essai reviendrait à verrouiller le titulaire qui a simplement
      // oublié qu'il passe par Google.
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: PASSWORD_NOT_SET_LOGIN_MESSAGE,
        code: PASSWORD_NOT_SET_CODE,
      });
    }

    if (!(await this.verifyPassword(record.passwordHash, dto.password))) {
      await this.loginLockout.recordFailure(email);
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    await this.loginLockout.recordSuccess(email);

    // `testSenderAddress` n'est pas une colonne Prisma : voir la
    // documentation de `AuthUser.testSenderAddress` (`auth.types.ts`).
    const user = toAuthUser(
      record,
      resolveTestSenderAddress(this.configService),
    );

    const token = await this.sessionService.create(user.id);

    return { user, token };
  }

  /**
   * Connexion par Google (B30), une fois l'`id_token` validé par
   * `GoogleOAuthService`. Résout le compte, puis ouvre la session avec la
   * même fonction que `login`. Ordre de résolution :
   *
   * 1. par `googleSub` : connexion ;
   * 2. sinon par email (normalisé comme à l'inscription) :
   *    - déjà rattaché à un AUTRE `googleSub` : `google_compte_conflit` ;
   *    - sinon rattachement. Si le compte n'était **pas confirmé**, son mot
   *      de passe n'a jamais été prouvé par le titulaire de l'adresse :
   *      quelqu'un a pu s'inscrire avec l'adresse d'autrui et attendre que
   *      la victime arrive par Google (pré-détournement). On efface donc le
   *      mot de passe et on révoque toutes les sessions, puis on confirme le
   *      compte par le chemin de confirmation existant (crédit de bienvenue
   *      versé une seule fois) ;
   * 3. sinon création : compte confirmé d'emblée, sans mot de passe, crédit
   *    de bienvenue versé dans la même transaction.
   *
   * Un compte suspendu obtient sa session comme à la connexion par mot de
   * passe : ce sont les gardes qui renvoient 403.
   */
  async loginWithGoogle(identity: GoogleIdentity): Promise<AuthResult> {
    let userId: string;

    try {
      userId = await this.resolveGoogleAccount(identity);
    } catch (error) {
      // Course entre deux rappels simultanés qui créent le même compte : le
      // second trouve, au nouvel essai, ce que le premier a écrit.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        userId = await this.resolveGoogleAccount(identity);
      } else {
        throw error;
      }
    }

    const record = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: AUTH_USER_RECORD_SELECT,
    });
    const user = toAuthUser(
      record,
      resolveTestSenderAddress(this.configService),
    );

    const token = await this.sessionService.create(user.id);

    return { user, token };
  }

  private resolveGoogleAccount(identity: GoogleIdentity): Promise<string> {
    const email = normalizeEmail(identity.email);

    return this.prisma.$transaction(async (tx) => {
      const bySub = await tx.user.findUnique({
        where: { googleSub: identity.sub },
        select: { id: true },
      });

      if (bySub) {
        return bySub.id;
      }

      const now = new Date();
      const byEmail = await tx.user.findUnique({
        where: { email },
        select: { id: true, googleSub: true, emailVerifiedAt: true },
      });

      if (byEmail) {
        if (byEmail.googleSub !== null) {
          throw new GoogleAuthError(
            GOOGLE_ERROR.ACCOUNT_CONFLICT,
            `compte ${byEmail.id} déjà rattaché à un autre identifiant Google`,
          );
        }

        const unconfirmed = byEmail.emailVerifiedAt === null;

        // Conditionnel sur `googleSub: null` : c'est la base qui arbitre si
        // un rattachement concurrent est passé entre la lecture et ici.
        const linked = await tx.user.updateMany({
          where: { id: byEmail.id, googleSub: null },
          data: {
            googleSub: identity.sub,
            ...(unconfirmed ? { passwordHash: null } : {}),
          },
        });

        if (linked.count === 0) {
          throw new GoogleAuthError(
            GOOGLE_ERROR.ACCOUNT_CONFLICT,
            `compte ${byEmail.id} rattaché par un rappel concurrent`,
          );
        }

        if (unconfirmed) {
          await this.emailConfirmation.markVerified(tx, byEmail.id, now);
          // Dernière étape avant la validation de la transaction : si la
          // révocation échoue, rien n'est écrit en base.
          await this.sessionService.destroyAllForUser(byEmail.id);
        }

        this.logger.log(
          `Compte ${byEmail.id} rattaché à Google` +
            (unconfirmed
              ? ' (non confirmé : mot de passe effacé, sessions révoquées, compte confirmé)'
              : ''),
        );

        return byEmail.id;
      }

      const created = await tx.user.create({
        data: {
          email,
          name: googleDisplayName(identity.name, email),
          passwordHash: null,
          emailVerifiedAt: now,
          googleSub: identity.sub,
        },
        select: { id: true },
      });

      await this.emailConfirmation.grantWelcomeCredits(tx, created.id, now);

      this.logger.log(`Compte ${created.id} créé par Google`);

      return created.id;
    });
  }

  /**
   * Met à jour partiellement le profil (`name` / `company` / `declaredUsage`).
   * `company` et `declaredUsage` acceptent `''` ou `null` pour effacer la
   * valeur existante. Au moins un champ doit être fourni (l'email, jamais
   * modifiable ici, est déjà retiré en amont par le `ValidationPipe`).
   *
   * **Confirmation d'adresse** : cette route ne peut pas changer `email` —
   * `UpdateProfileDto` n'a pas ce champ et le `ValidationPipe` global
   * (`whitelist: true`) l'écarte silencieusement s'il est envoyé. Le jeton de
   * confirmation en cours n'a donc rien à craindre d'ici. L'invariant « une
   * adresse qui change périme le jeton » n'est malgré tout pas confié à ce
   * code : il est porté par la donnée (`User.emailVerificationSentTo`, comparé
   * à `User.email` au moment de la confirmation), donc valable pour n'importe
   * quel futur chemin de modification d'adresse, y compris celui qu'on n'a pas
   * encore écrit.
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

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: AUTH_USER_RECORD_SELECT,
    });

    // `testSenderAddress` n'est pas une colonne Prisma : voir la
    // documentation de `AuthUser.testSenderAddress` (`auth.types.ts`). Sans
    // cette ligne, `PATCH /v1/auth/me` renverrait un utilisateur sans ce
    // champ alors que `GET /v1/auth/me` (via `SessionAuthGuard`) l'expose —
    // exactement la régression signalée par l'agent frontend.
    return toAuthUser(updated, resolveTestSenderAddress(this.configService));
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

    if (!user) {
      throw new UnauthorizedException(WRONG_CURRENT_PASSWORD_MESSAGE);
    }

    if (user.passwordHash === null) {
      // Compte sans mot de passe (B30) : rien à comparer, et surtout pas un
      // « mot de passe actuel incorrect » trompeur.
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: PASSWORD_NOT_SET_CHANGE_MESSAGE,
        code: PASSWORD_NOT_SET_CODE,
      });
    }

    if (!(await this.verifyPassword(user.passwordHash, dto.currentPassword))) {
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

/** Longueur maximale d'un nom, alignée sur `RegisterDto.name`. */
const NAME_MAX_LENGTH = 200;

/**
 * Nom d'un compte créé par Google : le claim `name`, à défaut la partie
 * locale de l'adresse. Borné comme à l'inscription.
 */
function googleDisplayName(name: string | null, email: string): string {
  const trimmed = name?.trim() ?? '';
  const chosen = trimmed.length > 0 ? trimmed : email.split('@')[0];

  return chosen.slice(0, NAME_MAX_LENGTH);
}

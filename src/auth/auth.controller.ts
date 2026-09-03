import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { CaptchaGuard } from '../captcha/captcha.guard';
import { RATE_LIMIT_POLICY } from '../rate-limit/rate-limit.constants';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { SESSION_COOKIE_NAME } from './auth.constants';
import { AuthService } from './auth.service';
import type { AuthUser } from './auth.types';
import { CurrentUser } from './current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ConfirmEmailDto } from './dto/confirm-email.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import type {
  ConfirmEmailResult,
  ResendConfirmationResult,
} from './email-confirmation.service';
import { EmailConfirmationService } from './email-confirmation.service';
import { SessionAuthGuard } from './session-auth.guard';
import {
  baseSessionCookieOptions,
  readSessionCookie,
  sessionCookieOptions,
} from './session-cookie';
import { SessionService } from './session.service';

/**
 * Avertissement de démarrage quand le cookie de session reste hôte-seul en
 * production : le proxy Next de `zendou.app` n'a alors aucun moyen de le lire.
 */
export const SESSION_COOKIE_DOMAIN_MISSING_WARNING =
  'SESSION_COOKIE_DOMAIN absente : le proxy du frontend ne pourra pas lire le cookie de session';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly isProduction: boolean;
  /**
   * Valeur de `SESSION_COOKIE_DOMAIN`, lue **une seule fois** : la
   * configuration ne change pas en cours de vie du processus, et chaque route
   * qui pose ou efface le cookie doit utiliser exactement la même valeur.
   */
  private readonly cookieDomain: string | undefined;

  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    private readonly emailConfirmationService: EmailConfirmationService,
    configService: ConfigService,
  ) {
    this.isProduction = configService.get<string>('NODE_ENV') === 'production';
    this.cookieDomain = configService.get<string>('SESSION_COOKIE_DOMAIN');

    if (this.isProduction && !this.cookieDomain) {
      this.logger.warn(SESSION_COOKIE_DOMAIN_MISSING_WARNING);
    }
  }

  /**
   * Efface le cookie de session sous **les deux** formes possibles.
   *
   * Un cookie posé avant l'arrivée de `SESSION_COOKIE_DOMAIN` est un cookie
   * hôte-seul (sans attribut `Domain`) ; celui posé depuis en porte un. Pour
   * le navigateur ce sont deux cookies distincts, et un `Set-Cookie`
   * d'effacement ne supprime que celui dont les attributs correspondent. Sans
   * ce double effacement, les sessions ouvertes avant le déploiement
   * survivraient à la déconnexion - un cookie que l'utilisateur croit détruit
   * et qui reste dans son navigateur.
   */
  private clearSessionCookie(response: Response): void {
    response.clearCookie(
      SESSION_COOKIE_NAME,
      baseSessionCookieOptions(this.isProduction, this.cookieDomain),
    );

    if (this.cookieDomain) {
      response.clearCookie(
        SESSION_COOKIE_NAME,
        baseSessionCookieOptions(this.isProduction),
      );
    }
  }

  // Route non authentifiée : comptée par IP (et par adresse visée), jamais
  // par utilisateur — il n'y en a pas encore. `CaptchaGuard` s'ajoute en
  // complément de cette limite (pas en remplacement) : lui seul protège
  // contre la création massive de comptes, le vecteur qui expose le compte
  // SES partagé à un spammeur. Aucune autre route n'a ce garde.
  @Post('register')
  @RateLimit(RATE_LIMIT_POLICY.REGISTER)
  @UseGuards(CaptchaGuard)
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthUser> {
    const { user, token } = await this.authService.register(dto);
    response.cookie(
      SESSION_COOKIE_NAME,
      token,
      sessionCookieOptions(this.isProduction, this.cookieDomain),
    );
    return user;
  }

  // Deux fenêtres cumulées (rafale + acharnement lent), comptées en parallèle
  // sur l'IP et sur l'adresse visée : l'IP seule ne suffit pas quand des
  // milliers d'abonnés Orange/MTN la partagent, l'email seul ne suffit pas
  // quand l'attaquant en change à chaque essai.
  @Post('login')
  @RateLimit(RATE_LIMIT_POLICY.LOGIN)
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthUser> {
    const { user, token } = await this.authService.login(dto);
    response.cookie(
      SESSION_COOKIE_NAME,
      token,
      sessionCookieOptions(this.isProduction, this.cookieDomain),
    );
    return user;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const token = readSessionCookie(request);

    if (token) {
      await this.sessionService.destroy(token);
    }

    this.clearSessionCookie(response);
  }

  /**
   * Confirmation de l'adresse email. Route **non authentifiée** : le lien est
   * souvent ouvert depuis le client de messagerie, donc dans un navigateur qui
   * ne porte pas le cookie de session. Le jeton est la seule preuve exigée —
   * il en faut 256 bits pour rien d'autre.
   *
   * Pas de politique de limitation dédiée : la politique globale (120/min par
   * identité) s'applique, et deviner un jeton de 256 bits n'est pas un plan.
   */
  @Post('confirm-email')
  @HttpCode(HttpStatus.OK)
  confirmEmail(@Body() dto: ConfirmEmailDto): Promise<ConfirmEmailResult> {
    return this.emailConfirmationService.confirm(dto.token);
  }

  /**
   * Renvoi du lien de confirmation. Compté **par utilisateur** : la limite
   * protège la boîte du titulaire de l'adresse, pas notre infrastructure —
   * voir `RESEND_CONFIRMATION_PER_HOUR`.
   */
  @Post('resend-confirmation')
  @UseGuards(SessionAuthGuard)
  @RateLimit(RATE_LIMIT_POLICY.RESEND_CONFIRMATION)
  @HttpCode(HttpStatus.ACCEPTED)
  resendConfirmation(
    @CurrentUser() user: AuthUser,
  ): Promise<ResendConfirmationResult> {
    return this.emailConfirmationService.resend(user.id);
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  @HttpCode(HttpStatus.OK)
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @Patch('me')
  @UseGuards(SessionAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updateMe(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<AuthUser> {
    return this.authService.updateProfile(user.id, dto);
  }

  // Route authentifiée : comptée par utilisateur, pas par IP — deux clients
  // derrière la même IP publique ne doivent pas se pénaliser mutuellement.
  @Post('change-password')
  @UseGuards(SessionAuthGuard)
  @RateLimit(RATE_LIMIT_POLICY.CHANGE_PASSWORD)
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.changePassword(user.id, dto);

    // Toutes les sessions de l'utilisateur (y compris celle-ci) viennent
    // d'être révoquées côté Redis : on efface aussi le cookie du navigateur
    // courant pour rester cohérent. Le client devra se reconnecter avec le
    // nouveau mot de passe.
    this.clearSessionCookie(response);
  }
}

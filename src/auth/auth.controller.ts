import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { SESSION_COOKIE_NAME } from './auth.constants';
import { AuthService } from './auth.service';
import type { AuthUser } from './auth.types';
import { CurrentUser } from './current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SessionAuthGuard } from './session-auth.guard';
import {
  baseSessionCookieOptions,
  readSessionCookie,
  sessionCookieOptions,
} from './session-cookie';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  private readonly isProduction: boolean;

  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    configService: ConfigService,
  ) {
    this.isProduction = configService.get<string>('NODE_ENV') === 'production';
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthUser> {
    const { user, token } = await this.authService.register(dto);
    response.cookie(
      SESSION_COOKIE_NAME,
      token,
      sessionCookieOptions(this.isProduction),
    );
    return user;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthUser> {
    const { user, token } = await this.authService.login(dto);
    response.cookie(
      SESSION_COOKIE_NAME,
      token,
      sessionCookieOptions(this.isProduction),
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

    response.clearCookie(
      SESSION_COOKIE_NAME,
      baseSessionCookieOptions(this.isProduction),
    );
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

  @Post('change-password')
  @UseGuards(SessionAuthGuard)
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
    response.clearCookie(
      SESSION_COOKIE_NAME,
      baseSessionCookieOptions(this.isProduction),
    );
  }
}

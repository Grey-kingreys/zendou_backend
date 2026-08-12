import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: "L'adresse email est invalide" })
  email!: string;

  @IsString()
  @MinLength(8, {
    message: 'Le mot de passe doit contenir au moins 8 caractères',
  })
  @MaxLength(200)
  password!: string;

  @IsString()
  @MinLength(2, { message: 'Le nom doit contenir au moins 2 caractères' })
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  declaredUsage?: string;

  /**
   * Jeton Cloudflare Turnstile obtenu côté client. Structurellement optionnel
   * ici : c'est `CaptchaGuard` qui l'exige (et rejette son absence par un
   * 400) **uniquement quand le captcha est activé** — voir
   * `src/captcha/captcha.guard.ts`. Quand il est désactivé, ce champ est
   * ignoré s'il est présent.
   */
  @IsOptional()
  @IsString()
  captchaToken?: string;
}

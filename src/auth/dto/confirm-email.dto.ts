import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { EMAIL_CONFIRMATION_TOKEN_MAX_LENGTH } from '../email-confirmation.constants';

/**
 * Corps de `POST /v1/auth/confirm-email`.
 *
 * `MaxLength` n'a pas de sens métier (un jeton légitime fait 43 caractères) :
 * c'est une borne d'entrée, pour ne pas calculer un SHA-256 sur un corps de
 * requête arbitrairement long fourni par un anonyme — la route n'est pas
 * authentifiée.
 */
export class ConfirmEmailDto {
  @IsString()
  @IsNotEmpty({ message: 'Le jeton de confirmation est obligatoire' })
  @MaxLength(EMAIL_CONFIRMATION_TOKEN_MAX_LENGTH)
  token!: string;
}

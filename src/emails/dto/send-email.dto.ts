import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { INVALID_HEADERS_MESSAGE } from '../email-headers';
import {
  INVALID_FROM_MESSAGE,
  INVALID_REPLY_TO_MESSAGE,
  INVALID_TO_MESSAGE,
  SUBJECT_LENGTH_MESSAGE,
  SUBJECT_MAX_LENGTH,
} from '../emails.constants';

/**
 * Corps de `POST /v1/emails`. Ne vérifie ici que la forme ; le format des
 * adresses et la présence d'un contenu relèvent d'`EmailsService`, avec
 * les mêmes messages.
 */
export class SendEmailDto {
  @IsString({ message: INVALID_FROM_MESSAGE })
  @IsNotEmpty({ message: INVALID_FROM_MESSAGE })
  from!: string;

  @IsString({ message: INVALID_TO_MESSAGE })
  @IsNotEmpty({ message: INVALID_TO_MESSAGE })
  to!: string;

  /**
   * Adresse à laquelle les réponses doivent arriver, facultative.
   *
   * Soumise **à la même règle que `from`** dans `EmailsService.accept()` : son
   * domaine doit être vérifié et rattaché au compte. Sans quoi un client
   * pourrait expédier depuis un domaine qu'il possède et faire atterrir la
   * conversation chez un tiers, sous une signature DKIM de Zendou.
   */
  @IsOptional()
  @IsString({ message: INVALID_REPLY_TO_MESSAGE })
  @IsNotEmpty({ message: INVALID_REPLY_TO_MESSAGE })
  replyTo?: string;

  @IsString({ message: SUBJECT_LENGTH_MESSAGE })
  @Length(1, SUBJECT_MAX_LENGTH, { message: SUBJECT_LENGTH_MESSAGE })
  subject!: string;

  @IsOptional()
  @IsString()
  html?: string;

  @IsOptional()
  @IsString()
  text?: string;

  /**
   * En-têtes personnalisés (liste blanche : `List-Unsubscribe`,
   * `List-Unsubscribe-Post`, `X-*` hors `X-SES-*`). La forme seule est
   * vérifiée ici ; noms, valeurs et plafond le sont par `EmailsService.send()`
   * (`validateCustomHeaders`), avec des messages précis.
   */
  @IsOptional()
  @IsObject({ message: INVALID_HEADERS_MESSAGE })
  headers?: Record<string, string>;
}

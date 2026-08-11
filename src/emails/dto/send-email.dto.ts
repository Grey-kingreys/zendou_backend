import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';
import {
  INVALID_FROM_MESSAGE,
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

  @IsString({ message: SUBJECT_LENGTH_MESSAGE })
  @Length(1, SUBJECT_MAX_LENGTH, { message: SUBJECT_LENGTH_MESSAGE })
  subject!: string;

  @IsOptional()
  @IsString()
  html?: string;

  @IsOptional()
  @IsString()
  text?: string;
}

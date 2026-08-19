import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSmtpCredentialDto {
  @IsString()
  @MinLength(1, { message: 'Le nom est requis' })
  @MaxLength(100, {
    message: 'Le nom doit contenir au plus 100 caractères',
  })
  name!: string;
}

import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateSmtpCredentialDto {
  @IsString()
  @MinLength(1, { message: 'Le nom est requis' })
  @MaxLength(100, {
    message: 'Le nom doit contenir au plus 100 caractères',
  })
  name!: string;

  /**
   * Portée par domaine (B27). Absent ou vide : tous les domaines du compte.
   * Sinon : identifiants de domaines vérifiés du compte (contrôlés par le
   * service).
   */
  @IsOptional()
  @IsArray({ message: 'Les domaines doivent être une liste' })
  @IsString({ each: true, message: 'Chaque domaine doit être un identifiant' })
  domainIds?: string[];
}

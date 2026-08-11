import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Mise à jour partielle du profil connecté (`PATCH /v1/auth/me`).
 *
 * Tous les champs sont optionnels au niveau du DTO : la règle « au moins un
 * champ doit être fourni » porte sur l'objet entier, elle est donc vérifiée
 * dans `AuthService.updateProfile`, pas ici.
 *
 * `company` et `declaredUsage` acceptent explicitement `''` ou `null` pour
 * effacer la valeur existante : `@IsOptional()` de class-validator ignore
 * les validateurs suivants uniquement pour `null`/`undefined`, une chaîne
 * vide continue donc d'être validée normalement (et passe, puisque `''`
 * respecte `@MaxLength(200)`).
 *
 * PAS de champ `email` ici : c'est volontaire. L'email est l'identifiant de
 * connexion et n'est pas modifiable dans cette version — le rendre
 * modifiable demanderait une vérification par email, qui n'existe pas
 * encore. Si le body contient `email`, le `ValidationPipe` global
 * (`whitelist: true`, voir `src/main.ts`) le retire silencieusement avant
 * que ce DTO ne soit construit : ce n'est pas un oubli.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Le nom doit contenir au moins 2 caractères' })
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  declaredUsage?: string | null;
}

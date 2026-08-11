import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RegisterDto } from './register.dto';
import { UpdateProfileDto } from './update-profile.dto';

/**
 * Verrou de cohérence : `RegisterDto.name` et `UpdateProfileDto.name`
 * doivent accepter exactement la même longueur maximale.
 *
 * Historique : `UpdateProfileDto.name` plafonnait à 100 caractères alors que
 * `RegisterDto.name` plafonnait à 200. Un utilisateur inscrit avec un nom de
 * 101 à 200 caractères recevait un 400 dès sa première mise à jour de
 * profil, sans aucun moyen de le corriger depuis cet écran. Ce test échoue
 * si les deux bornes se désynchronisent à nouveau, dans un sens comme dans
 * l'autre.
 */
const pipe = new ValidationPipe({ whitelist: true });

const registerMetadata = {
  type: 'body' as const,
  metatype: RegisterDto,
  data: '',
};

const updateProfileMetadata = {
  type: 'body' as const,
  metatype: UpdateProfileDto,
  data: '',
};

const NAME_MAX_LENGTH = 200;
const maxLengthName = 'A'.repeat(NAME_MAX_LENGTH);
const tooLongName = 'A'.repeat(NAME_MAX_LENGTH + 1);

describe('Cohérence RegisterDto/UpdateProfileDto — longueur de `name`', () => {
  it(`accepte un nom de ${NAME_MAX_LENGTH} caractères à l'inscription`, async () => {
    await expect(
      pipe.transform(
        {
          email: 'aissatou@example.com',
          password: 'motdepasse-valide',
          name: maxLengthName,
        },
        registerMetadata,
      ),
    ).resolves.toHaveProperty('name', maxLengthName);
  });

  it(`accepte un nom de ${NAME_MAX_LENGTH} caractères à la mise à jour du profil`, async () => {
    await expect(
      pipe.transform({ name: maxLengthName }, updateProfileMetadata),
    ).resolves.toHaveProperty('name', maxLengthName);
  });

  it(`rejette un nom de ${NAME_MAX_LENGTH + 1} caractères à l'inscription`, async () => {
    await expect(
      pipe.transform(
        {
          email: 'aissatou@example.com',
          password: 'motdepasse-valide',
          name: tooLongName,
        },
        registerMetadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it(`rejette un nom de ${NAME_MAX_LENGTH + 1} caractères à la mise à jour du profil`, async () => {
    await expect(
      pipe.transform({ name: tooLongName }, updateProfileMetadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

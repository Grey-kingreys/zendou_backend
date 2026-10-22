import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateApiKeyDto } from '../api-keys/dto/create-api-key.dto';
import { CreateSmtpCredentialDto } from '../smtp-credentials/dto/create-smtp-credential.dto';

describe.each([
  ['CreateApiKeyDto', CreateApiKeyDto],
  ['CreateSmtpCredentialDto', CreateSmtpCredentialDto],
])('%s - domainIds (B27)', (_label, Dto) => {
  const check = (body: unknown) =>
    validate(plainToInstance(Dto, body as object));

  it('est facultatif', async () => {
    expect(await check({ name: 'Prod' })).toHaveLength(0);
  });

  it('accepte une liste (même vide) de chaînes', async () => {
    expect(await check({ name: 'Prod', domainIds: [] })).toHaveLength(0);
    expect(await check({ name: 'Prod', domainIds: ['a', 'b'] })).toHaveLength(
      0,
    );
  });

  it('refuse autre chose qu’une liste', async () => {
    expect(await check({ name: 'Prod', domainIds: 'a' })).not.toHaveLength(0);
  });

  it('accepte 50 domaines et refuse 51, en français', async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);

    expect(await check({ name: 'Prod', domainIds: ids(50) })).toHaveLength(0);

    const errors = await check({ name: 'Prod', domainIds: ids(51) });

    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {})).toEqual([
      'Une portée ne peut pas contenir plus de 50 domaines',
    ]);
  });

  it('refuse une liste qui contient autre chose que des chaînes', async () => {
    expect(await check({ name: 'Prod', domainIds: ['a', 3] })).not.toHaveLength(
      0,
    );
  });
});

describe('CreateApiKeyDto - canRead', () => {
  const check = (body: unknown) =>
    validate(plainToInstance(CreateApiKeyDto, body as object));

  it('est facultatif et accepte un booléen', async () => {
    expect(await check({ name: 'Prod' })).toHaveLength(0);
    expect(await check({ name: 'Prod', canRead: true })).toHaveLength(0);
    expect(await check({ name: 'Prod', canRead: false })).toHaveLength(0);
  });

  it.each(['true', 1, 0, 'oui', [], {}])(
    'refuse %p, en français',
    async (value) => {
      const errors = await check({ name: 'Prod', canRead: value });

      expect(errors).toHaveLength(1);
      expect(Object.values(errors[0].constraints ?? {})).toEqual([
        'La permission de lecture doit être un booléen',
      ]);
    },
  );
});

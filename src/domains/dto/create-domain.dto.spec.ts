import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateDomainDto } from './create-domain.dto';

const pipe = new ValidationPipe({ whitelist: true });
const metadata = {
  type: 'body' as const,
  metatype: CreateDomainDto,
  data: '',
};

describe('CreateDomainDto', () => {
  it('lowercases and trims the domain name', async () => {
    const result = (await pipe.transform(
      { name: '  Boutique-Awa.GN ' },
      metadata,
    )) as CreateDomainDto;

    expect(result.name).toBe('boutique-awa.gn');
  });

  it.each(['http://x.com', 'pas-de-point', '1.2.3.4', ''])(
    'rejects %p with a 400',
    async (name) => {
      await expect(pipe.transform({ name }, metadata)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it('strips unknown properties', async () => {
    const result = (await pipe.transform(
      { name: 'boutique-awa.gn', status: 'VERIFIED' },
      metadata,
    )) as Record<string, unknown>;

    expect(result).toEqual({ name: 'boutique-awa.gn' });
  });
});

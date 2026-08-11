import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength } from 'class-validator';
import {
  DOMAIN_NAME_MAX_LENGTH,
  DOMAIN_NAME_REGEX,
  INVALID_DOMAIN_NAME_MESSAGE,
} from '../domains.constants';

export class CreateDomainDto {
  @IsString()
  @MaxLength(DOMAIN_NAME_MAX_LENGTH, { message: INVALID_DOMAIN_NAME_MESSAGE })
  @Matches(DOMAIN_NAME_REGEX, { message: INVALID_DOMAIN_NAME_MESSAGE })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  name!: string;
}

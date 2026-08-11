import { IsOptional, IsString, Length } from 'class-validator';
import { REASON_MAX_LENGTH, REASON_MIN_LENGTH } from '../admin.constants';

/** Corps de `POST /v1/admin/users/:id/reactivate` — motif facultatif. */
export class ReactivateUserDto {
  @IsOptional()
  @IsString()
  @Length(REASON_MIN_LENGTH, REASON_MAX_LENGTH)
  reason?: string;
}

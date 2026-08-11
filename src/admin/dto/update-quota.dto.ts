import { IsInt, Max, Min } from 'class-validator';
import { MAX_DAILY_SEND_LIMIT, MIN_DAILY_SEND_LIMIT } from '../admin.constants';

/** Corps de `PATCH /v1/admin/users/:id/quota`. */
export class UpdateQuotaDto {
  @IsInt()
  @Min(MIN_DAILY_SEND_LIMIT)
  @Max(MAX_DAILY_SEND_LIMIT)
  dailySendLimit!: number;
}

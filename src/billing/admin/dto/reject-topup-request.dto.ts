import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Corps de `POST /v1/admin/topup-requests/:id/reject`. */
export class RejectTopUpRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

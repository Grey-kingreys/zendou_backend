import { IsInt, IsNotIn, IsString, Length, Max, Min } from 'class-validator';
import {
  MAX_CREDIT_DELTA,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
} from '../admin.constants';

/**
 * Corps de `POST /v1/admin/users/:id/credits`. Le delta peut être négatif —
 * un geste commercial se reprend (erreur de saisie, avoir accordé à tort) —
 * mais jamais nul : un mouvement à zéro ne serait que du bruit dans le ledger.
 */
export class GrantCreditsDto {
  @IsInt()
  @IsNotIn([0], { message: 'delta ne peut pas être nul.' })
  @Min(-MAX_CREDIT_DELTA)
  @Max(MAX_CREDIT_DELTA)
  delta!: number;

  @IsString()
  @Length(REASON_MIN_LENGTH, REASON_MAX_LENGTH)
  reason!: string;
}

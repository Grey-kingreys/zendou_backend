import { IsString, Length } from 'class-validator';
import { REASON_MAX_LENGTH, REASON_MIN_LENGTH } from '../admin.constants';

/**
 * Corps de `POST /v1/admin/users/:id/suspend`. Le motif est **obligatoire** :
 * une suspension sans motif est ingérable pour le support comme pour le
 * client qui appelle en demandant pourquoi son compte est coupé.
 */
export class SuspendUserDto {
  @IsString()
  @Length(REASON_MIN_LENGTH, REASON_MAX_LENGTH)
  reason!: string;
}

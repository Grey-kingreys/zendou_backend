import { IsEnum, IsNotEmpty, IsString, Length } from 'class-validator';
import { TopUpMethod } from '@prisma/client';
import {
  INVALID_METHOD_MESSAGE,
  INVALID_PHONE_MESSAGE,
  PACK_NOT_FOUND_MESSAGE,
  TRANSACTION_REF_LENGTH_MESSAGE,
  TRANSACTION_REF_MAX_LENGTH,
  TRANSACTION_REF_MIN_LENGTH,
} from '../billing.constants';

/**
 * Corps de `POST /v1/billing/topup-requests`. Ne vérifie ici que la forme ;
 * l'existence/l'achetabilité du pack, le format fin du téléphone et le
 * doublon de référence relèvent de `BillingService`.
 */
export class CreateTopUpRequestDto {
  @IsString({ message: PACK_NOT_FOUND_MESSAGE })
  @IsNotEmpty({ message: PACK_NOT_FOUND_MESSAGE })
  packId!: string;

  @IsEnum(TopUpMethod, { message: INVALID_METHOD_MESSAGE })
  method!: TopUpMethod;

  @IsString({ message: INVALID_PHONE_MESSAGE })
  @IsNotEmpty({ message: INVALID_PHONE_MESSAGE })
  phoneNumber!: string;

  @IsString({ message: TRANSACTION_REF_LENGTH_MESSAGE })
  @Length(TRANSACTION_REF_MIN_LENGTH, TRANSACTION_REF_MAX_LENGTH, {
    message: TRANSACTION_REF_LENGTH_MESSAGE,
  })
  transactionRef!: string;
}

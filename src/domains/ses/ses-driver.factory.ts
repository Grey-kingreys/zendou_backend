import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DevStubDriver } from './dev-stub.driver';
import { SesSdkDriver } from './ses-sdk.driver';
import {
  SES_IDENTITY_DRIVER,
  type SesIdentityDriver,
} from './ses-identity-driver';

/** Région SES par défaut si `AWS_REGION` n'est pas renseignée. */
const DEFAULT_AWS_REGION = 'eu-west-3';

/**
 * Choisit le driver SES : sans `AWS_ACCESS_KEY_ID`, on bascule sur le stub
 * de développement pour que le module fonctionne sans compte AWS.
 */
export function createSesIdentityDriver(
  configService: ConfigService,
): SesIdentityDriver {
  const logger = new Logger('SesIdentityDriver');
  const accessKeyId = read(configService, 'AWS_ACCESS_KEY_ID');
  const secretAccessKey = read(configService, 'AWS_SECRET_ACCESS_KEY');

  if (!accessKeyId) {
    logger.warn(
      '[SES stub] AWS_ACCESS_KEY_ID absent — driver de développement activé, aucun appel AWS ne sera émis',
    );
    return new DevStubDriver();
  }

  return new SesSdkDriver({
    region: read(configService, 'AWS_REGION') || DEFAULT_AWS_REGION,
    accessKeyId,
    secretAccessKey,
  });
}

export const sesIdentityDriverProvider: Provider = {
  provide: SES_IDENTITY_DRIVER,
  inject: [ConfigService],
  useFactory: createSesIdentityDriver,
};

function read(configService: ConfigService, key: string): string {
  return (configService.get<string>(key) ?? '').trim();
}

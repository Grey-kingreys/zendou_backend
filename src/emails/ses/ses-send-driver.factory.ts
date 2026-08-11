import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendDevStubDriver } from './send-dev-stub.driver';
import { SES_SEND_DRIVER, type SesSendDriver } from './ses-send-driver';
import { SesSendSdkDriver } from './ses-send-sdk.driver';

/** Région SES par défaut si `AWS_REGION` n'est pas renseignée. */
const DEFAULT_AWS_REGION = 'eu-west-3';

/**
 * Choisit le driver d'envoi : sans `AWS_ACCESS_KEY_ID`, on bascule sur le
 * stub de développement pour que le pipeline tourne sans compte AWS.
 */
export function createSesSendDriver(
  configService: ConfigService,
): SesSendDriver {
  const logger = new Logger('SesSendDriver');
  const accessKeyId = read(configService, 'AWS_ACCESS_KEY_ID');

  if (!accessKeyId) {
    logger.warn(
      '[SES send stub] AWS_ACCESS_KEY_ID absent — driver de développement activé, aucun email ne sera réellement remis',
    );
    return new SendDevStubDriver();
  }

  return new SesSendSdkDriver({
    region: read(configService, 'AWS_REGION') || DEFAULT_AWS_REGION,
    accessKeyId,
    secretAccessKey: read(configService, 'AWS_SECRET_ACCESS_KEY'),
    configurationSet: read(configService, 'SES_CONFIGURATION_SET') || undefined,
  });
}

export const sesSendDriverProvider: Provider = {
  provide: SES_SEND_DRIVER,
  inject: [ConfigService],
  useFactory: createSesSendDriver,
};

function read(configService: ConfigService, key: string): string {
  return (configService.get<string>(key) ?? '').trim();
}

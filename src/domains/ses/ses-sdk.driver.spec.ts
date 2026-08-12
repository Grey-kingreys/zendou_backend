import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  AlreadyExistsException,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { SesSdkDriver } from './ses-sdk.driver';

/** Reproduit la forme d'une exception `AlreadyExistsException` du SDK AWS. */
function alreadyExistsError(domain: string): AlreadyExistsException {
  return new AlreadyExistsException({
    message: `Email identity ${domain} already exist.`,
    $metadata: {},
  });
}

describe('SesSdkDriver.createIdentity', () => {
  let sendSpy: jest.SpyInstance;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    sendSpy = jest.spyOn(SESv2Client.prototype, 'send');
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  function driver(): SesSdkDriver {
    return new SesSdkDriver({
      region: 'eu-west-3',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
    });
  }

  it('creates the identity and returns the DKIM tokens (cas nominal)', async () => {
    sendSpy.mockImplementation((command: unknown) => {
      expect(command).toBeInstanceOf(CreateEmailIdentityCommand);
      return Promise.resolve({
        DkimAttributes: { Tokens: ['tok-1', 'tok-2', 'tok-3'] },
      });
    });

    const result = await driver().createIdentity('boutique-awa.gn');

    expect(result).toEqual({ dkimTokens: ['tok-1', 'tok-2', 'tok-3'] });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('recovers the DKIM tokens when the identity already exists in the SES account', async () => {
    sendSpy
      .mockImplementationOnce((command: unknown) => {
        expect(command).toBeInstanceOf(CreateEmailIdentityCommand);
        return Promise.reject(alreadyExistsError('mail.kingreys.fr'));
      })
      .mockImplementationOnce((command: unknown) => {
        expect(command).toBeInstanceOf(GetEmailIdentityCommand);
        return Promise.resolve({
          DkimAttributes: { Tokens: ['tok-a', 'tok-b', 'tok-c'] },
        });
      });

    const result = await driver().createIdentity('mail.kingreys.fr');

    expect(result).toEqual({ dkimTokens: ['tok-a', 'tok-b', 'tok-c'] });
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('throws a clear ServiceUnavailableException when GetEmailIdentity fails after AlreadyExists', async () => {
    sendSpy
      .mockImplementationOnce(() =>
        Promise.reject(alreadyExistsError('mail.kingreys.fr')),
      )
      .mockImplementationOnce(() => Promise.reject(new Error('network blip')));

    await expect(
      driver().createIdentity('mail.kingreys.fr'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('throws a clear ServiceUnavailableException when the recovered identity has no DKIM token', async () => {
    sendSpy
      .mockImplementationOnce(() =>
        Promise.reject(alreadyExistsError('mail.kingreys.fr')),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ DkimAttributes: { Tokens: [] } }),
      );

    await expect(
      driver().createIdentity('mail.kingreys.fr'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lets unrelated exceptions propagate unchanged', async () => {
    const boom = new Error('boom');
    sendSpy.mockImplementationOnce(() => Promise.reject(boom));

    await expect(driver().createIdentity('boutique-awa.gn')).rejects.toBe(boom);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

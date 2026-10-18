import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  AlreadyExistsException,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { DomainStatus } from '@prisma/client';
import { SesSdkDriver } from './ses-sdk.driver';

/** Commande SES remise au n-ième appel de `send`. */
function commandAt(spy: jest.SpyInstance, index: number): unknown {
  return (spy.mock.calls as unknown[][])[index][0];
}

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
    sendSpy.mockImplementation((command: unknown) =>
      Promise.resolve(
        command instanceof CreateEmailIdentityCommand
          ? { DkimAttributes: { Tokens: ['tok-1', 'tok-2', 'tok-3'] } }
          : {},
      ),
    );

    const result = await driver().createIdentity('boutique-awa.gn');

    expect(result).toEqual({ dkimTokens: ['tok-1', 'tok-2', 'tok-3'] });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(commandAt(sendSpy, 0)).toBeInstanceOf(CreateEmailIdentityCommand);
  });

  it('pose le MAIL FROM bounce.<domaine> avec repli sur la valeur par défaut, après la création', async () => {
    sendSpy.mockImplementation((command: unknown) =>
      Promise.resolve(
        command instanceof CreateEmailIdentityCommand
          ? { DkimAttributes: { Tokens: ['tok-1', 'tok-2', 'tok-3'] } }
          : {},
      ),
    );

    await driver().createIdentity('boutique-awa.gn');

    const put = commandAt(
      sendSpy,
      1,
    ) as PutEmailIdentityMailFromAttributesCommand;
    expect(put).toBeInstanceOf(PutEmailIdentityMailFromAttributesCommand);
    expect(put.input).toEqual({
      EmailIdentity: 'boutique-awa.gn',
      MailFromDomain: 'bounce.boutique-awa.gn',
      BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
    });
  });

  it('crée quand même le domaine si la pose du MAIL FROM échoue', async () => {
    sendSpy.mockImplementation((command: unknown) =>
      command instanceof CreateEmailIdentityCommand
        ? Promise.resolve({ DkimAttributes: { Tokens: ['tok-1'] } })
        : Promise.reject(new Error('AccessDenied')),
    );

    await expect(driver().createIdentity('boutique-awa.gn')).resolves.toEqual({
      dkimTokens: ['tok-1'],
    });
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
      })
      .mockImplementationOnce(() => Promise.resolve({}));

    const result = await driver().createIdentity('mail.kingreys.fr');

    expect(result).toEqual({ dkimTokens: ['tok-a', 'tok-b', 'tok-c'] });
    // Create, Get, puis la pose du MAIL FROM absent.
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(commandAt(sendSpy, 2)).toBeInstanceOf(
      PutEmailIdentityMailFromAttributesCommand,
    );
  });

  it('ne repose pas le MAIL FROM d une identité préexistante qui le porte déjà', async () => {
    sendSpy
      .mockImplementationOnce(() =>
        Promise.reject(alreadyExistsError('mail.kingreys.fr')),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          DkimAttributes: { Tokens: ['tok-a'] },
          MailFromAttributes: {
            MailFromDomain: 'bounce.mail.kingreys.fr',
            MailFromDomainStatus: 'SUCCESS',
          },
        }),
      );

    await driver().createIdentity('mail.kingreys.fr');

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

describe('SesSdkDriver.getIdentityStatus', () => {
  let sendSpy: jest.SpyInstance;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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

  it('pose le MAIL FROM d un domaine existant quand il est absent, et rend PENDING', async () => {
    sendSpy.mockImplementation((command: unknown) =>
      Promise.resolve(
        command instanceof GetEmailIdentityCommand
          ? { DkimAttributes: { Status: 'SUCCESS' } }
          : {},
      ),
    );

    const result = await driver().getIdentityStatus('boutique-awa.gn');

    expect(result).toEqual({
      status: DomainStatus.VERIFIED,
      mailFromStatus: 'PENDING',
    });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    const put = commandAt(
      sendSpy,
      1,
    ) as PutEmailIdentityMailFromAttributesCommand;
    expect(put).toBeInstanceOf(PutEmailIdentityMailFromAttributesCommand);
    expect(put.input).toEqual({
      EmailIdentity: 'boutique-awa.gn',
      MailFromDomain: 'bounce.boutique-awa.gn',
      BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
    });
  });

  it('ne repose pas le MAIL FROM quand il est déjà posé et rend son statut', async () => {
    sendSpy.mockImplementation(() =>
      Promise.resolve({
        DkimAttributes: { Status: 'SUCCESS' },
        MailFromAttributes: {
          MailFromDomain: 'bounce.boutique-awa.gn',
          MailFromDomainStatus: 'SUCCESS',
        },
      }),
    );

    const result = await driver().getIdentityStatus('boutique-awa.gn');

    expect(result).toEqual({
      status: DomainStatus.VERIFIED,
      mailFromStatus: 'SUCCESS',
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('rend un statut MAIL FROM nul quand la pose échoue, sans faire échouer le rafraîchissement', async () => {
    sendSpy.mockImplementation((command: unknown) =>
      command instanceof GetEmailIdentityCommand
        ? Promise.resolve({ DkimAttributes: { Status: 'PENDING' } })
        : Promise.reject(new Error('Throttling')),
    );

    await expect(
      driver().getIdentityStatus('boutique-awa.gn'),
    ).resolves.toEqual({
      status: DomainStatus.PENDING,
      mailFromStatus: null,
    });
  });
});

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DkimStatus } from '@aws-sdk/client-sesv2';
import { DomainStatus } from '@prisma/client';
import { DevStubDriver, stubDkimTokens } from './dev-stub.driver';
import { createSesIdentityDriver } from './ses-driver.factory';
import { SesSdkDriver, mapDkimStatus } from './ses-sdk.driver';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string): string | undefined => values[key],
  } as unknown as ConfigService;
}

describe('createSesIdentityDriver', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('falls back to the dev stub when AWS_ACCESS_KEY_ID is missing', () => {
    const driver = createSesIdentityDriver(
      configWith({ AWS_REGION: 'eu-west-3' }),
    );

    expect(driver).toBeInstanceOf(DevStubDriver);
  });

  it('falls back to the dev stub when AWS_ACCESS_KEY_ID is blank', () => {
    expect(
      createSesIdentityDriver(configWith({ AWS_ACCESS_KEY_ID: '' })),
    ).toBeInstanceOf(DevStubDriver);
    expect(
      createSesIdentityDriver(configWith({ AWS_ACCESS_KEY_ID: '   ' })),
    ).toBeInstanceOf(DevStubDriver);
  });

  it('uses the real SESv2 driver once credentials are configured', () => {
    const driver = createSesIdentityDriver(
      configWith({
        AWS_REGION: 'eu-west-3',
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'secret',
      }),
    );

    expect(driver).toBeInstanceOf(SesSdkDriver);
  });
});

describe('DevStubDriver', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  const driver = new DevStubDriver();

  it('generates 3 deterministic pseudo DKIM tokens per domain', async () => {
    const first = await driver.createIdentity('boutique-awa.gn');
    const second = await driver.createIdentity('boutique-awa.gn');
    const other = await driver.createIdentity('autre-domaine.gn');

    expect(first.dkimTokens).toHaveLength(3);
    expect(first.dkimTokens).toEqual(second.dkimTokens);
    expect(first.dkimTokens).toEqual(stubDkimTokens('boutique-awa.gn'));
    expect(new Set(first.dkimTokens).size).toBe(3);
    expect(first.dkimTokens).not.toEqual(other.dkimTokens);

    for (const token of first.dkimTokens) {
      expect(token).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('reports PENDING and deletes without side effect', async () => {
    await expect(driver.getIdentityStatus('boutique-awa.gn')).resolves.toBe(
      DomainStatus.PENDING,
    );
    await expect(
      driver.deleteIdentity('boutique-awa.gn'),
    ).resolves.toBeUndefined();
  });
});

describe('mapDkimStatus', () => {
  it.each([
    [DkimStatus.SUCCESS, DomainStatus.VERIFIED],
    [DkimStatus.FAILED, DomainStatus.FAILED],
    [DkimStatus.TEMPORARY_FAILURE, DomainStatus.TEMPORARY_FAILURE],
    [DkimStatus.PENDING, DomainStatus.PENDING],
    [DkimStatus.NOT_STARTED, DomainStatus.PENDING],
  ])('maps %s to %s', (sesStatus, expected) => {
    expect(mapDkimStatus(sesStatus)).toBe(expected);
  });

  it('falls back to PENDING when SES returns no status', () => {
    expect(mapDkimStatus(undefined)).toBe(DomainStatus.PENDING);
  });
});

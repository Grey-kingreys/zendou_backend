import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SendDevStubDriver } from './send-dev-stub.driver';
import { createSesSendDriver } from './ses-send-driver.factory';
import {
  SesSendError,
  isPermanentSendError,
  type SesSendPayload,
} from './ses-send-driver';
import {
  SesSendSdkDriver,
  buildBody,
  classifySesSendError,
  describeError,
  toSesSendError,
} from './ses-send-sdk.driver';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string): string | undefined => values[key],
  } as unknown as ConfigService;
}

function payload(overrides: Partial<SesSendPayload> = {}): SesSendPayload {
  return {
    from: 'contact@boutique-awa.gn',
    to: 'client@exemple.gn',
    subject: 'Votre commande est prête',
    html: '<p>Bonjour</p>',
    ...overrides,
  };
}

/** Reproduit la forme d'une exception du SDK AWS. */
function awsError(name: string, httpStatusCode?: number): Error {
  const error = new Error(`${name} levée par SES`);
  error.name = name;
  Object.assign(error, { $metadata: { httpStatusCode } });
  return error;
}

describe('createSesSendDriver', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('falls back to the dev stub when AWS_ACCESS_KEY_ID is missing', () => {
    expect(
      createSesSendDriver(configWith({ AWS_REGION: 'eu-west-3' })),
    ).toBeInstanceOf(SendDevStubDriver);
  });

  it('falls back to the dev stub when AWS_ACCESS_KEY_ID is blank', () => {
    expect(
      createSesSendDriver(configWith({ AWS_ACCESS_KEY_ID: '' })),
    ).toBeInstanceOf(SendDevStubDriver);
    expect(
      createSesSendDriver(configWith({ AWS_ACCESS_KEY_ID: '   ' })),
    ).toBeInstanceOf(SendDevStubDriver);
  });

  it('uses the real SESv2 driver once credentials are configured', () => {
    expect(
      createSesSendDriver(
        configWith({
          AWS_REGION: 'eu-west-3',
          AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
          AWS_SECRET_ACCESS_KEY: 'secret',
          SES_CONFIGURATION_SET: 'zendou',
        }),
      ),
    ).toBeInstanceOf(SesSendSdkDriver);
  });
});

describe('SendDevStubDriver', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const driver = new SendDevStubDriver();

  it('always succeeds with a recognisable stub message id', async () => {
    const first = await driver.send(payload());
    const second = await driver.send(payload());

    expect(first.messageId).toMatch(/^stub-[0-9a-f]{16}$/);
    expect(second.messageId).not.toBe(first.messageId);
  });

  it('traces the send without any network call', async () => {
    const { messageId } = await driver.send(payload({ text: 'Bonjour' }));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('[SES send stub]');
    expect(logged[0]).toContain('contact@boutique-awa.gn');
    expect(logged[0]).toContain('client@exemple.gn');
    expect(logged[0]).toContain(messageId);
  });
});

describe('buildBody', () => {
  it('maps html and text to the SES Simple content', () => {
    expect(buildBody(payload({ text: 'Bonjour' }))).toEqual({
      Html: { Data: '<p>Bonjour</p>', Charset: 'UTF-8' },
      Text: { Data: 'Bonjour', Charset: 'UTF-8' },
    });
  });

  it('omits the variant that was not provided', () => {
    expect(buildBody(payload({ html: undefined, text: 'Bonjour' }))).toEqual({
      Text: { Data: 'Bonjour', Charset: 'UTF-8' },
    });
  });
});

describe('classifySesSendError', () => {
  it.each([
    'MessageRejected',
    'MailFromDomainNotVerifiedException',
    'AccountSuspendedException',
    'SendingPausedException',
    'BadRequestException',
    'LimitExceededException',
  ])('treats %s as permanent', (name) => {
    expect(classifySesSendError(awsError(name))).toBe('PERMANENT');
  });

  it.each([
    'TooManyRequestsException',
    'InternalServiceErrorException',
    'TimeoutError',
    'ThrottlingException',
  ])('treats %s as transient', (name) => {
    expect(classifySesSendError(awsError(name))).toBe('TRANSIENT');
  });

  it('treats network error codes as transient', () => {
    const error = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });

    expect(classifySesSendError(error)).toBe('TRANSIENT');
  });

  it('reads the HTTP status when the name is unknown', () => {
    expect(classifySesSendError(awsError('MysteryException', 400))).toBe(
      'PERMANENT',
    );
    expect(classifySesSendError(awsError('MysteryException', 429))).toBe(
      'TRANSIENT',
    );
    expect(classifySesSendError(awsError('MysteryException', 503))).toBe(
      'TRANSIENT',
    );
  });

  it('retries rather than drops when nothing is recognisable', () => {
    expect(classifySesSendError(new Error('boum'))).toBe('TRANSIENT');
    expect(classifySesSendError('boum')).toBe('TRANSIENT');
    expect(classifySesSendError(undefined)).toBe('TRANSIENT');
  });

  it('keeps the verdict already carried by a SesSendError', () => {
    expect(
      classifySesSendError(new SesSendError('PERMANENT', 'déjà classée')),
    ).toBe('PERMANENT');
  });
});

describe('toSesSendError', () => {
  it('wraps an AWS exception while keeping its name and cause', () => {
    const original = awsError('MessageRejected', 400);
    const wrapped = toSesSendError(original);

    expect(wrapped).toBeInstanceOf(SesSendError);
    expect(wrapped.kind).toBe('PERMANENT');
    expect(wrapped.permanent).toBe(true);
    expect(wrapped.message).toBe(
      'MessageRejected: MessageRejected levée par SES',
    );
    expect(wrapped.cause).toBe(original);
    expect(isPermanentSendError(wrapped)).toBe(true);
  });

  it('leaves an already normalised error untouched', () => {
    const error = new SesSendError('TRANSIENT', 'throttling');

    expect(toSesSendError(error)).toBe(error);
    expect(isPermanentSendError(error)).toBe(false);
  });

  it('does not treat a plain error as permanent', () => {
    expect(isPermanentSendError(new Error('boum'))).toBe(false);
  });
});

describe('describeError', () => {
  it('prefixes the message with the AWS exception name', () => {
    expect(describeError(awsError('MessageRejected'))).toBe(
      'MessageRejected: MessageRejected levée par SES',
    );
  });

  it('drops the uninformative wrapper names', () => {
    expect(describeError(new Error('timeout'))).toBe('timeout');
    expect(describeError(new SesSendError('TRANSIENT', 'timeout'))).toBe(
      'timeout',
    );
  });
});

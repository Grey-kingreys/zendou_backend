import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createSign, generateKeyPairSync } from 'node:crypto';
import {
  deliveryFixture,
  permanentBounceFixture,
  subscriptionConfirmationFixture,
} from './fixtures';
import { SnsHttpClient } from './sns-http.client';
import {
  buildStringToSign,
  isTrustedSnsUrl,
  SnsSignatureValidator,
} from './sns-signature.validator';
import type { SnsMessage } from './sns-webhook.types';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const PUBLIC_KEY_PEM = publicKey.export({
  type: 'spki',
  format: 'pem',
}) as string;

/** Signe le message comme le ferait SNS (v1 = SHA1, v2 = SHA256). */
function sign(message: SnsMessage): SnsMessage {
  const algorithm =
    message.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  const signature = createSign(algorithm)
    .update(buildStringToSign(message), 'utf8')
    .sign(privateKey, 'base64');

  return { ...message, Signature: signature };
}

describe('buildStringToSign', () => {
  it('serialises a notification field by field, in the SNS order', () => {
    const message = {
      Type: 'Notification',
      MessageId: 'msg-1',
      TopicArn: 'arn:aws:sns:eu-west-3:123456789012:zendou-ses-events',
      Subject: 'Amazon SES Email Event Notification',
      Message: '{"eventType":"Delivery"}',
      Timestamp: '2026-08-11T10:00:03.456Z',
    } as SnsMessage;

    expect(buildStringToSign(message)).toBe(
      [
        'Message\n{"eventType":"Delivery"}\n',
        'MessageId\nmsg-1\n',
        'Subject\nAmazon SES Email Event Notification\n',
        'Timestamp\n2026-08-11T10:00:03.456Z\n',
        'TopicArn\narn:aws:sns:eu-west-3:123456789012:zendou-ses-events\n',
        'Type\nNotification\n',
      ].join(''),
    );
  });

  it('omits the optional Subject when SNS did not send one', () => {
    const message = {
      Type: 'Notification',
      MessageId: 'msg-1',
      TopicArn: 'topic',
      Message: 'payload',
      Timestamp: '2026-08-11T10:00:03.456Z',
    } as SnsMessage;

    expect(buildStringToSign(message)).toBe(
      'Message\npayload\nMessageId\nmsg-1\nTimestamp\n2026-08-11T10:00:03.456Z\nTopicArn\ntopic\nType\nNotification\n',
    );
  });

  it('uses the subscription field set (Token, SubscribeURL) for confirmations', () => {
    const message = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'msg-2',
      TopicArn: 'topic',
      Message: 'confirm me',
      SubscribeURL:
        'https://sns.eu-west-3.amazonaws.com/?Action=ConfirmSubscription',
      Token: 'tok',
      Timestamp: '2026-08-11T09:59:00.123Z',
    } as SnsMessage;

    expect(buildStringToSign(message)).toBe(
      [
        'Message\nconfirm me\n',
        'MessageId\nmsg-2\n',
        'SubscribeURL\nhttps://sns.eu-west-3.amazonaws.com/?Action=ConfirmSubscription\n',
        'Timestamp\n2026-08-11T09:59:00.123Z\n',
        'Token\ntok\n',
        'TopicArn\ntopic\n',
        'Type\nSubscriptionConfirmation\n',
      ].join(''),
    );
  });
});

describe('isTrustedSnsUrl', () => {
  it.each([
    ['https://sns.eu-west-3.amazonaws.com/cert.pem', true],
    ['https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription', true],
    // HTTP en clair : rejeté.
    ['http://sns.eu-west-3.amazonaws.com/cert.pem', false],
    // Domaine d'attaquant, y compris les faux suffixes.
    ['https://sns.eu-west-3.amazonaws.com.evil.gn/cert.pem', false],
    ['https://evil.gn/sns.eu-west-3.amazonaws.com/cert.pem', false],
    ['https://s3.eu-west-3.amazonaws.com/cert.pem', false],
    ['pas-une-url', false],
    [undefined, false],
  ])('%s -> %s', (url, expected) => {
    expect(isTrustedSnsUrl(url)).toBe(expected);
  });
});

describe('SnsSignatureValidator', () => {
  let validator: SnsSignatureValidator;

  const httpClient = { get: jest.fn() };
  const env: Record<string, unknown> = {
    NODE_ENV: 'test',
    SNS_SKIP_SIGNATURE_VALIDATION: false,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    env.NODE_ENV = 'test';
    env.SNS_SKIP_SIGNATURE_VALIDATION = false;
    httpClient.get.mockResolvedValue(PUBLIC_KEY_PEM);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SnsSignatureValidator,
        { provide: SnsHttpClient, useValue: httpClient },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
      ],
    }).compile();

    validator = module.get(SnsSignatureValidator);
  });

  it('accepts a SignatureVersion 1 (SHA1withRSA) notification', async () => {
    await expect(validator.isValid(sign(deliveryFixture()))).resolves.toBe(
      true,
    );
    expect(httpClient.get).toHaveBeenCalledWith(
      'https://sns.eu-west-3.amazonaws.com/SimpleNotificationService-7ff5318490ec183fbaddaa2a969abfda.pem',
    );
  });

  it('accepts a SignatureVersion 2 (SHA256withRSA) notification', async () => {
    const message = sign({ ...deliveryFixture(), SignatureVersion: '2' });

    await expect(validator.isValid(message)).resolves.toBe(true);
  });

  it('accepts a signed SubscriptionConfirmation', async () => {
    await expect(
      validator.isValid(sign(subscriptionConfirmationFixture())),
    ).resolves.toBe(true);
  });

  it('rejects a message whose payload was tampered with after signing', async () => {
    const signed = sign(permanentBounceFixture());
    const tampered: SnsMessage = {
      ...signed,
      Message: signed.Message.replace(
        'Mamadou.Barry@Example.COM',
        'victime@example.com',
      ),
    };

    await expect(validator.isValid(tampered)).resolves.toBe(false);
  });

  it('rejects the raw fixture signature (not signed by our test key)', async () => {
    await expect(validator.isValid(deliveryFixture())).resolves.toBe(false);
  });

  it('rejects an unsupported SignatureVersion without fetching anything', async () => {
    const message = { ...sign(deliveryFixture()), SignatureVersion: '3' };

    await expect(validator.isValid(message)).resolves.toBe(false);
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it('refuses to download a certificate from a non-AWS host', async () => {
    const message = {
      ...sign(deliveryFixture()),
      SigningCertURL: 'https://evil.gn/cert.pem',
    };

    await expect(validator.isValid(message)).resolves.toBe(false);
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it('refuses to download a certificate over plain HTTP', async () => {
    const message = {
      ...sign(deliveryFixture()),
      SigningCertURL: 'http://sns.eu-west-3.amazonaws.com/cert.pem',
    };

    await expect(validator.isValid(message)).resolves.toBe(false);
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it('caches the certificate per URL', async () => {
    await validator.isValid(sign(deliveryFixture()));
    await validator.isValid(sign(permanentBounceFixture()));

    expect(httpClient.get).toHaveBeenCalledTimes(1);
  });

  it('rejects (without throwing) when the certificate cannot be downloaded', async () => {
    httpClient.get.mockRejectedValue(new Error('HTTP 404'));

    await expect(validator.isValid(sign(deliveryFixture()))).resolves.toBe(
      false,
    );
  });

  it('skips validation when SNS_SKIP_SIGNATURE_VALIDATION is on outside production', async () => {
    env.SNS_SKIP_SIGNATURE_VALIDATION = true;

    await expect(validator.isValid(deliveryFixture())).resolves.toBe(true);
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it('ignores the skip flag in production', async () => {
    env.SNS_SKIP_SIGNATURE_VALIDATION = true;
    env.NODE_ENV = 'production';

    await expect(validator.isValid(deliveryFixture())).resolves.toBe(false);
    expect(httpClient.get).toHaveBeenCalled();
  });
});

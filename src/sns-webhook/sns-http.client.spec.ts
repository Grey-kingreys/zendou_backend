import { Readable } from 'node:stream';
import { get } from 'node:https';
import { SnsHttpClient } from './sns-http.client';

jest.mock('node:https', () => ({ get: jest.fn() }));

const httpsGet = get as unknown as jest.Mock;

interface FakeResponse extends Readable {
  statusCode?: number;
}

function respondWith(statusCode: number, body: string): void {
  httpsGet.mockImplementation(
    (
      _url: string,
      _options: unknown,
      callback: (res: FakeResponse) => void,
    ) => {
      const response = Readable.from([body]) as FakeResponse;
      response.statusCode = statusCode;
      callback(response);
      return { on: jest.fn().mockReturnThis(), destroy: jest.fn() };
    },
  );
}

describe('SnsHttpClient', () => {
  const client = new SnsHttpClient();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('downloads the body over HTTPS', async () => {
    respondWith(200, '-----BEGIN CERTIFICATE-----\nMIIF...\n');

    await expect(
      client.get('https://sns.eu-west-3.amazonaws.com/cert.pem'),
    ).resolves.toContain('BEGIN CERTIFICATE');

    expect(httpsGet).toHaveBeenCalledTimes(1);
    const [calledUrl] = httpsGet.mock.calls[0] as [string];
    expect(calledUrl).toBe('https://sns.eu-west-3.amazonaws.com/cert.pem');
  });

  it('rejects on a non-2xx response', async () => {
    respondWith(404, 'Not Found');

    await expect(
      client.get('https://sns.eu-west-3.amazonaws.com/missing.pem'),
    ).rejects.toThrow('HTTP 404');
  });
});

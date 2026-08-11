import { Test, TestingModule } from '@nestjs/testing';
import { SESSION_REDIS, SESSION_TTL_SECONDS } from './auth.constants';
import { SessionService } from './session.service';

describe('SessionService', () => {
  let service: SessionService;

  const redis = {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    expire: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [SessionService, { provide: SESSION_REDIS, useValue: redis }],
    }).compile();

    service = module.get<SessionService>(SessionService);
  });

  it('creates an opaque 32-byte base64url token with a 7 day TTL', async () => {
    const token = await service.create('user_1');

    // 32 octets encodés en base64url => 43 caractères, sans padding ni +/=
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(SESSION_TTL_SECONDS).toBe(604800);
    expect(redis.set).toHaveBeenCalledWith(
      `sess:${token}`,
      'user_1',
      'EX',
      SESSION_TTL_SECONDS,
    );
  });

  it('generates a different token on every call', async () => {
    const first = await service.create('user_1');
    const second = await service.create('user_1');

    expect(first).not.toBe(second);
  });

  it('resolves the user id and slides the TTL forward', async () => {
    redis.get.mockResolvedValue('user_1');

    await expect(service.resolve('tok')).resolves.toBe('user_1');

    expect(redis.get).toHaveBeenCalledWith('sess:tok');
    expect(redis.expire).toHaveBeenCalledWith('sess:tok', SESSION_TTL_SECONDS);
  });

  it('returns null for an expired session and does not refresh anything', async () => {
    redis.get.mockResolvedValue(null);

    await expect(service.resolve('tok')).resolves.toBeNull();
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('destroys the session key', async () => {
    await service.destroy('tok');

    expect(redis.del).toHaveBeenCalledWith('sess:tok');
  });
});

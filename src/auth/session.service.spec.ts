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
    sadd: jest.fn(),
    srem: jest.fn(),
    smembers: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    redis.smembers.mockResolvedValue([]);

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

  it('adds the token to the reverse per-user set on creation (SADD) with a matching TTL', async () => {
    const token = await service.create('user_1');

    expect(redis.sadd).toHaveBeenCalledWith('usersess:user_1', token);
    expect(redis.expire).toHaveBeenCalledWith(
      'usersess:user_1',
      SESSION_TTL_SECONDS,
    );
  });

  it('resolves the user id and slides the TTL forward', async () => {
    redis.get.mockResolvedValue('user_1');

    await expect(service.resolve('tok')).resolves.toBe('user_1');

    expect(redis.get).toHaveBeenCalledWith('sess:tok');
    expect(redis.expire).toHaveBeenCalledWith('sess:tok', SESSION_TTL_SECONDS);
  });

  it('also slides the TTL of the reverse per-user set on resolve', async () => {
    redis.get.mockResolvedValue('user_1');

    await service.resolve('tok');

    expect(redis.expire).toHaveBeenCalledWith(
      'usersess:user_1',
      SESSION_TTL_SECONDS,
    );
  });

  it('returns null for an expired session and does not refresh anything', async () => {
    redis.get.mockResolvedValue(null);

    await expect(service.resolve('tok')).resolves.toBeNull();
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('destroys the session key', async () => {
    redis.get.mockResolvedValue('user_1');

    await service.destroy('tok');

    expect(redis.del).toHaveBeenCalledWith('sess:tok');
  });

  it('removes the token from the reverse per-user set on logout (SREM)', async () => {
    redis.get.mockResolvedValue('user_1');

    await service.destroy('tok');

    expect(redis.srem).toHaveBeenCalledWith('usersess:user_1', 'tok');
  });

  it('does not attempt SREM when destroying a session absent from Redis', async () => {
    redis.get.mockResolvedValue(null);

    await service.destroy('tok');

    expect(redis.del).toHaveBeenCalledWith('sess:tok');
    expect(redis.srem).not.toHaveBeenCalled();
  });

  describe('destroyAllForUser', () => {
    it('deletes every sess: key referenced by the user set plus the set itself', async () => {
      redis.smembers.mockResolvedValue(['tok1', 'tok2']);

      await service.destroyAllForUser('user_1');

      expect(redis.smembers).toHaveBeenCalledWith('usersess:user_1');
      expect(redis.del).toHaveBeenCalledWith(
        'sess:tok1',
        'sess:tok2',
        'usersess:user_1',
      );
    });

    it('still deletes the (empty) user set when it has no members', async () => {
      redis.smembers.mockResolvedValue([]);

      await service.destroyAllForUser('user_1');

      expect(redis.del).toHaveBeenCalledWith('usersess:user_1');
    });
  });
});

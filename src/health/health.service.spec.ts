import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SmtpServerService } from '../smtp/smtp-server.service';
import { HealthService } from './health.service';

/**
 * `ioredis` est instancié directement dans le constructeur de `HealthService`
 * (pas d'injection par jeton) : on le remplace par un double contrôlable pour
 * isoler la logique de `check()` — en particulier le repli `smtp` (B6/S10,
 * A16) — de toute connexion réseau réelle.
 */
const redisPing = jest.fn();
const redisDisconnect = jest.fn();

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    ping: redisPing,
    disconnect: redisDisconnect,
  }));
});

describe('HealthService — champ smtp (B6/S10, A16)', () => {
  let prisma: { $queryRaw: jest.Mock };
  let configValues: Record<string, unknown>;
  let smtpServerService: { isListening: boolean };

  async function buildService(): Promise<HealthService> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => configValues[key] },
        },
        { provide: SmtpServerService, useValue: smtpServerService },
      ],
    }).compile();

    return moduleRef.get(HealthService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    redisPing.mockResolvedValue('PONG');
    configValues = { REDIS_URL: 'redis://localhost:6379' };
    smtpServerService = { isListening: false };
  });

  it('reports smtp: disabled and an overall ok status when SMTP_RELAY_ENABLED is absent', async () => {
    const service = await buildService();

    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      smtp: 'disabled',
    });
  });

  it('reports smtp: disabled when SMTP_RELAY_ENABLED is explicitly false', async () => {
    configValues.SMTP_RELAY_ENABLED = false;
    const service = await buildService();

    await expect(service.check()).resolves.toMatchObject({ smtp: 'disabled' });
  });

  it('reports smtp: ok when the relay is enabled and every instance is listening', async () => {
    configValues.SMTP_RELAY_ENABLED = true;
    smtpServerService.isListening = true;
    const service = await buildService();

    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      smtp: 'ok',
    });
  });

  it('reports smtp: down and flips the overall status to error when the relay is enabled but not listening', async () => {
    configValues.SMTP_RELAY_ENABLED = true;
    smtpServerService.isListening = false;
    const service = await buildService();

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      db: 'ok',
      redis: 'ok',
      smtp: 'down',
    });
  });

  it('stays in error even when only smtp is down while db/redis are ok — a dead relay must not be masked', async () => {
    configValues.SMTP_RELAY_ENABLED = true;
    smtpServerService.isListening = false;
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redisPing.mockResolvedValue('PONG');
    const service = await buildService();

    const result = await service.check();

    expect(result.status).toBe('error');
    expect(result.db).toBe('ok');
    expect(result.redis).toBe('ok');
    expect(result.smtp).toBe('down');
  });
});

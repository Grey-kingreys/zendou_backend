import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;
  let healthService: { check: jest.Mock };

  beforeEach(async () => {
    healthService = { check: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: healthService }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns the health payload when db and redis are ok', async () => {
    healthService.check.mockResolvedValue({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
    });

    await expect(controller.check()).resolves.toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
    });
  });

  it('throws a 503 HttpException when db is down', async () => {
    healthService.check.mockResolvedValue({
      status: 'error',
      db: 'down',
      redis: 'ok',
    });

    await expect(controller.check()).rejects.toMatchObject(
      new HttpException(
        { status: 'error', db: 'down', redis: 'ok' },
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
    );
  });

  it('throws a 503 HttpException when redis is down', async () => {
    healthService.check.mockResolvedValue({
      status: 'error',
      db: 'ok',
      redis: 'down',
    });

    await expect(controller.check()).rejects.toMatchObject(
      new HttpException(
        { status: 'error', db: 'ok', redis: 'down' },
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
    );
  });
});

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';

export interface HealthStatus {
  status: 'ok' | 'error';
  db: 'ok' | 'down';
  redis: 'ok' | 'down';
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private readonly redisClient: Redis;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.redisClient = new Redis(configService.get<string>('REDIS_URL')!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.redisClient.on('error', (error) => {
      this.logger.error('Redis connection error', error);
    });
  }

  onModuleDestroy(): void {
    this.redisClient.disconnect();
  }

  async check(): Promise<HealthStatus> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);

    const status = db === 'ok' && redis === 'ok' ? 'ok' : 'error';

    return { status, db, redis };
  }

  private async checkDb(): Promise<'ok' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch (error) {
      this.logger.error('Database health check failed', error as Error);
      return 'down';
    }
  }

  private async checkRedis(): Promise<'ok' | 'down'> {
    try {
      const pong = await this.redisClient.ping();
      return pong === 'PONG' ? 'ok' : 'down';
    } catch (error) {
      this.logger.error('Redis health check failed', error as Error);
      return 'down';
    }
  }
}

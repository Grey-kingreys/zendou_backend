import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { SmtpServerService } from '../smtp/smtp-server.service';

export interface HealthStatus {
  status: 'ok' | 'error';
  db: 'ok' | 'down';
  redis: 'ok' | 'down';
  smtp: 'ok' | 'down' | 'disabled';
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private readonly redisClient: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly smtpServerService: SmtpServerService,
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
    const smtp = this.checkSmtp();

    // `disabled` n'est pas une panne (§6, A16) : seul `down` — le relais
    // activé mais silencieusement mort — doit faire basculer `/health` en
    // erreur, exactement comme `db`/`redis`.
    const status =
      db === 'ok' && redis === 'ok' && smtp !== 'down' ? 'ok' : 'error';

    return { status, db, redis, smtp };
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

  /**
   * `disabled` quand `SMTP_RELAY_ENABLED` est faux — état par défaut de tous
   * les environnements, y compris production (B6/S10, A16) : ce n'est pas une
   * panne, `SmtpServerService` n'a même pas tenté d'ouvrir de port.
   *
   * `SMTP_RELAY_ENABLED` est relu ici plutôt que déduit de
   * `SmtpServerService.isListening` : le relais peut être activé sans qu'une
   * seule instance ait jamais démarré (échec précoce), et cette variable est
   * la même source de vérité que celle qui gouverne `onModuleInit`.
   */
  private checkSmtp(): 'ok' | 'down' | 'disabled' {
    if (!this.configService.get<boolean>('SMTP_RELAY_ENABLED')) {
      return 'disabled';
    }

    return this.smtpServerService.isListening ? 'ok' : 'down';
  }
}

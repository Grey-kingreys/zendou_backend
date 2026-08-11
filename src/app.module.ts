import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { validateEnv } from './config/env.schema';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { EmailsLogModule } from './emails-log/emails-log.module';
import { EmailsModule } from './emails/emails.module';
import { DomainsModule } from './domains/domains.module';
import { ReputationModule } from './reputation';
import { SnsWebhookModule } from './sns-webhook/sns-webhook.module';
import { BillingModule } from './billing/billing.module';
import { AdminModule } from './admin';
import { SeedModule } from './seed/seed.module';
import { RateLimitModule } from './rate-limit';
import { EMAIL_SEND_QUEUE } from './queues/queues';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          url: configService.get<string>('REDIS_URL'),
        },
      }),
    }),
    BullModule.registerQueue({ name: EMAIL_SEND_QUEUE }),
    PrismaModule,
    RateLimitModule,
    HealthModule,
    AuthModule,
    ApiKeysModule,
    EmailsLogModule,
    EmailsModule,
    DomainsModule,
    ReputationModule,
    SnsWebhookModule,
    BillingModule,
    AdminModule,
    SeedModule,
  ],
})
export class AppModule {}

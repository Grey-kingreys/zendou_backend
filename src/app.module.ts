import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { validateEnv } from './config/env.schema';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { SmtpCredentialsModule } from './smtp-credentials/smtp-credentials.module';
import { SmtpRelayModule } from './smtp/smtp-relay.module';
import { SmtpCertAlertModule } from './smtp/smtp-cert-alert.module';
import { EmailsLogModule } from './emails-log/emails-log.module';
import { EmailsModule } from './emails/emails.module';
import { DomainsModule } from './domains/domains.module';
import { ReputationModule } from './reputation';
import { SnsWebhookModule } from './sns-webhook/sns-webhook.module';
import { CspReportModule } from './csp-report';
import { BillingModule } from './billing/billing.module';
import { AdminModule } from './admin';
import { SeedModule } from './seed/seed.module';
import { RateLimitModule } from './rate-limit';
import { RetentionModule } from './retention/retention.module';
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
    SmtpCredentialsModule,
    // Inerte tant que `SMTP_RELAY_ENABLED` n'est pas activée (B6/S5).
    SmtpRelayModule,
    // Idem : surveillance de l'expiration du certificat TLS (B6/H1).
    SmtpCertAlertModule,
    EmailsLogModule,
    EmailsModule,
    // Purge quotidienne des jobs en échec et du journal des envois (RET-12).
    // Actif dans tous les environnements, sans condition : voir
    // `retention.module.ts`.
    RetentionModule,
    DomainsModule,
    ReputationModule,
    SnsWebhookModule,
    // Boîte aux lettres des violations CSP du front (lot A).
    CspReportModule,
    BillingModule,
    AdminModule,
    SeedModule,
  ],
})
export class AppModule {}

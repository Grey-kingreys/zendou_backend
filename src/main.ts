import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { DEFAULT_TRUST_PROXY_HOPS } from './rate-limit/rate-limit.constants';
import { trustProxySetting } from './rate-limit/rate-limit.identity';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // Derrière le proxy Dokploy/Traefik, Express voit par défaut l'IP du proxy
  // et non celle du client : tous les clients partageraient alors un unique
  // compteur de limitation de débit, et le premier bourrin bloquerait tout le
  // monde. `trust proxy` fait retenir l'IP réelle écrite dans
  // `X-Forwarded-For`. Réglable via `TRUST_PROXY_HOPS` (0 = aucun proxy,
  // l'en-tête est ignoré car falsifiable).
  app.set(
    'trust proxy',
    trustProxySetting(
      configService.get<number>('TRUST_PROXY_HOPS') ?? DEFAULT_TRUST_PROXY_HOPS,
    ),
  );

  app.setGlobalPrefix('v1', {
    exclude: ['health'],
  });

  // La limite Express par défaut (100 Ko) est en deçà des 500 Ko autorisés
  // pour `html`/`text` sur `POST /v1/emails`.
  app.useBodyParser('json', { limit: '2mb' });

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
    }),
  );

  app.enableCors({
    origin: configService.get<string>('FRONTEND_ORIGIN'),
    credentials: true,
  });

  const port = configService.get<number>('PORT') ?? 4000;
  await app.listen(port);
}
void bootstrap();

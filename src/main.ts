import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupApp } from './app-setup';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // Tout le réglage de l'application vit dans `app-setup.ts`, où les tests
  // peuvent l'exercer : `main.ts` n'est jamais chargé par un test, puisqu'il
  // ouvre un port.
  setupApp(app, configService);

  const port = configService.get<number>('PORT') ?? 4000;
  await app.listen(port);
}
void bootstrap();

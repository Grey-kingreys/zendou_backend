import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { RateLimitCoreModule } from '../rate-limit/rate-limit-core.module';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { SecretHashingService } from './secret-hashing.service';

/**
 * `RateLimitCoreModule` apporte `RedisThrottlerStorage`, le compteur partagé
 * des échecs d'authentification par IP (lot C). Aucun cycle : ce module-là
 * n'importe qu'`AuthModule`, qui ignore tout des clés API.
 *
 * Il est **réexporté**, et ce n'est pas une commodité : `ApiKeyAuthGuard` est
 * posé par `@UseGuards(...)` sur `EmailsController`, que déclare `EmailsModule`.
 * Nest instancie un enhancer référencé par sa classe dans le contexte du module
 * qui déclare le contrôleur, pas dans celui qui l'exporte : le garde y est donc
 * reconstruit, et ses dépendances doivent être visibles **depuis
 * `EmailsModule`**. Exporter le garde seul ne suffit pas - c'est exactement ce
 * qui, mesuré en conditions réelles, laissait `RedisThrottlerStorage` à
 * `undefined` et désarmait la limite d'échecs sur la seule route qui compte.
 * Tout module qui importe celui-ci pour poser le garde reçoit donc aussi de
 * quoi le construire ; `api-key-failure-limit.wiring.spec.ts` le verrouille.
 */
@Module({
  imports: [AuthModule, RateLimitCoreModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService, ApiKeyAuthGuard, SecretHashingService],
  exports: [
    ApiKeysService,
    ApiKeyAuthGuard,
    SecretHashingService,
    RateLimitCoreModule,
  ],
})
export class ApiKeysModule {}

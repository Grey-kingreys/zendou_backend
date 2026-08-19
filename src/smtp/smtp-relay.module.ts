import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { SmtpAuthService } from './smtp-auth.service';
import { SmtpServerService } from './smtp-server.service';
import { SMTP_THROTTLE_REDIS } from './smtp-throttle.constants';
import { SmtpThrottleService } from './smtp-throttle.service';

/**
 * Relais SMTP entrant (B6/S5, étendu par S9).
 *
 * Toujours importé par `AppModule`, mais **inerte par défaut** : c'est
 * `SmtpServerService.onModuleInit` qui décide, à la lecture de
 * `SMTP_RELAY_ENABLED`, s'il faut ouvrir des ports. Un module conditionnel
 * (`forRoot` variable, `DynamicModule`) aurait déplacé cette décision dans le
 * graphe d'injection, là où elle est bien plus difficile à tester et à lire
 * qu'une ligne de journal au démarrage.
 *
 * Le client Redis de l'anti-abus est déclaré ici en `lazyConnect` : construit
 * avec le module, il n'ouvre aucune socket tant qu'aucune commande n'est
 * exécutée — donc jamais quand le relais est désactivé. L'inertie du module
 * survit à l'ajout de S9.
 *
 * Rien ici ne dépend de `main.ts` (contrepartie n°3 du §1.1) : le jour où le
 * relais devra tourner dans son propre processus, il suffira de créer un
 * contexte applicatif autour de ce module.
 */
@Module({
  // `PrismaModule` et `ConfigModule` sont globaux : rien à importer ici.
  providers: [
    {
      provide: SMTP_THROTTLE_REDIS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis => {
        const logger = new Logger('SmtpThrottleStore');
        // Même Redis que les compteurs HTTP (§5), même réglage de connexion —
        // et une connexion distincte, comme `RATE_LIMIT_REDIS` : les scripts
        // Lua sont enregistrés par `defineCommand` sur le client, deux jeux de
        // scripts sur un même client ne se gêneraient pas mais coupleraient
        // deux cycles de vie qui n'ont aucune raison de l'être. Ce sont les
        // **préfixes de clés** qui séparent les budgets, pas les connexions.
        const client = new Redis(configService.get<string>('REDIS_URL')!, {
          lazyConnect: true,
          // Un compteur ne doit jamais faire tomber le service : en cas de
          // coupure Redis, `SmtpThrottleService` journalise et laisse passer
          // plutôt que d'empiler des tentatives.
          maxRetriesPerRequest: 2,
        });
        client.on('error', (error: Error) => {
          logger.error('Redis smtp-throttle store error', error);
        });
        return client;
      },
    },
    SmtpThrottleService,
    SmtpAuthService,
    SmtpServerService,
  ],
  exports: [SmtpServerService, SmtpThrottleService],
})
export class SmtpRelayModule {}

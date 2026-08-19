import { Module } from '@nestjs/common';
import { SmtpAuthService } from './smtp-auth.service';
import { SmtpServerService } from './smtp-server.service';

/**
 * Relais SMTP entrant (B6/S5).
 *
 * Toujours importé par `AppModule`, mais **inerte par défaut** : c'est
 * `SmtpServerService.onModuleInit` qui décide, à la lecture de
 * `SMTP_RELAY_ENABLED`, s'il faut ouvrir des ports. Un module conditionnel
 * (`forRoot` variable, `DynamicModule`) aurait déplacé cette décision dans le
 * graphe d'injection, là où elle est bien plus difficile à tester et à lire
 * qu'une ligne de journal au démarrage.
 *
 * Rien ici ne dépend de `main.ts` (contrepartie n°3 du §1.1) : le jour où le
 * relais devra tourner dans son propre processus, il suffira de créer un
 * contexte applicatif autour de ce module.
 */
@Module({
  // `PrismaModule` et `ConfigModule` sont globaux : rien à importer ici.
  providers: [SmtpAuthService, SmtpServerService],
  exports: [SmtpServerService],
})
export class SmtpRelayModule {}

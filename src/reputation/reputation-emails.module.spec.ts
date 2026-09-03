import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { SESSION_REDIS } from '../auth/auth.constants';
import { EmailsCoreModule } from '../emails/emails-core.module';
import { EmailsService } from '../emails/emails.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import { REPUTATION_REDIS } from './reputation.constants';
import { ReputationModule } from './reputation.module';
import { ReputationService } from './reputation.service';

/**
 * E2 - preuve d'absence de cycle d'injection.
 *
 * `ReputationService` injecte désormais `EmailsService` pour expédier l'alerte
 * de suspension. C'est exactement le genre d'ajout qui ferme un cycle sans
 * prévenir : `ReputationModule` est `@Global()`, et le worker d'envoi
 * (`EmailSendProcessor`, dans `EmailsModule`) injecte déjà `ReputationService`
 * dans l'autre sens.
 *
 * Ce test compile les deux modules ensemble. Un cycle ferait échouer la
 * compilation avec l'erreur « circular dependency » de Nest - et il la ferait
 * échouer **ici**, à la seconde, plutôt qu'au démarrage du conteneur en
 * production. Seules les fondations sont doublées : Prisma, les deux clients
 * Redis, la file BullMQ et la configuration ; le graphe de modules, lui, est
 * celui de production.
 */
describe('ReputationModule + EmailsCoreModule - graphe d’injection (E2)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        // Les deux modules globaux qu'`AppModule` monte en production, et sans
        // lesquels aucun module de ce graphe ne pourrait résoudre `PrismaService`
        // ni `ConfigService`.
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        ReputationModule,
        EmailsCoreModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(getQueueToken(EMAIL_SEND_QUEUE))
      .useValue({ add: jest.fn() })
      .overrideProvider(REPUTATION_REDIS)
      .useValue({ set: jest.fn(), disconnect: jest.fn() })
      .overrideProvider(SESSION_REDIS)
      .useValue({ disconnect: jest.fn() })
      .overrideProvider(ConfigService)
      .useValue({ get: (): undefined => undefined })
      .compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('compile sans dépendance circulaire, donc sans forwardRef', () => {
    expect(moduleRef.get(ReputationService)).toBeInstanceOf(ReputationService);
  });

  /**
   * Le service doit avoir reçu le **vrai** `EmailsService`, celui
   * qu'`EmailsCoreModule` fournit. Une résolution qui rendrait `undefined`
   * compilerait tout aussi bien et ne casserait qu'au moment d'une suspension,
   * c'est-à-dire au pire moment.
   */
  it('reçoit le EmailsService fourni par EmailsCoreModule', () => {
    const injected = injectedEmailsService(moduleRef.get(ReputationService));

    expect(injected).toBe(moduleRef.get(EmailsService));
    expect(injected).toBeInstanceOf(EmailsService);
  });
});

/**
 * Lit la dépendance privée que Nest a réellement injectée. Le seul endroit du
 * projet où l'on regarde à l'intérieur d'un service, et pour la seule chose
 * qu'aucune API publique ne peut montrer : ce que le conteneur a branché.
 */
function injectedEmailsService(service: ReputationService): unknown {
  return (service as unknown as { emailsService: unknown }).emailsService;
}

import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { DEFAULT_TRUST_PROXY_HOPS } from './rate-limit/rate-limit.constants';
import { trustProxySetting } from './rate-limit/rate-limit.identity';

/**
 * Phrase rendue quand le corps porte un champ que le DTO ne déclare pas.
 *
 * Remplace le « property X should not exist » de class-validator : c'est la
 * seule contrainte que la bibliothèque produit elle-même, donc la seule qui
 * arriverait en anglais dans une API dont tous les autres messages sont en
 * français.
 */
export const UNKNOWN_FIELD_MESSAGE = (field: string): string =>
  `Le champ « ${field} » n'est pas accepté.`;

/** Clé de contrainte posée par class-validator sur un champ hors liste blanche. */
const WHITELIST_CONSTRAINT = 'whitelistValidation';

/**
 * En-têtes de réponse qu'un navigateur est autorisé à lire en cross-origin.
 *
 * Sans cette liste, `fetch` côté front voit bien le statut 429 mais **pas**
 * `Retry-After` : la spécification CORS masque tout en-tête de réponse hors
 * liste sûre. `frontend/src/lib/dns-check.ts` lit déjà `Retry-After` pour
 * afficher le délai d'attente ; les trois `X-RateLimit-*` complètent la même
 * information (budget restant) avant même le blocage.
 */
export const CORS_EXPOSED_HEADERS = [
  'Retry-After',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
];

/**
 * Types MIME confiés au parseur JSON global.
 *
 * Les deux derniers sont les formats de rapport de violation CSP : l'ancien
 * (`application/csp-report`, envoyé par `report-uri`) et celui de la Reporting
 * API (`application/reports+json`, envoyé par `report-to`). Sans eux, le corps
 * n'est pas parsé du tout et le module `csp-report` ne verrait jamais rien.
 */
export const JSON_BODY_TYPES = [
  'application/json',
  'application/csp-report',
  'application/reports+json',
];

/**
 * Fabrique d'exception par défaut de Nest, empruntée à une instance jetable de
 * `ValidationPipe`.
 *
 * `flattenValidationErrors` (aplatissement des erreurs enfants, préfixage par
 * le chemin du parent) est `protected` : impossible de l'appeler depuis
 * l'extérieur. `createExceptionFactory()`, lui, est public et rend exactement
 * la fabrique par défaut du pipe, celle qui aplatit puis construit la
 * `BadRequestException`. On délègue donc plutôt que de recopier une logique
 * qui pourrait diverger à la prochaine montée de version.
 */
const nestExceptionFactory = new ValidationPipe().createExceptionFactory();

/**
 * Fabrique d'exception du `ValidationPipe` global.
 *
 * Rend la même `BadRequestException` qu'aujourd'hui (message = tableau des
 * contraintes, que le filtre global normalise ensuite), à une substitution
 * près : chaque contrainte `whitelistValidation` est remplacée par
 * {@link UNKNOWN_FIELD_MESSAGE}.
 */
export function validationExceptionFactory(errors: ValidationError[]): unknown {
  return nestExceptionFactory(errors.map(translateWhitelistConstraint));
}

/**
 * Réécrit, en profondeur, la contrainte de liste blanche d'une erreur de
 * validation. Les autres contraintes (et la structure des enfants, dont Nest
 * a besoin pour préfixer les messages imbriqués) sont laissées intactes.
 */
function translateWhitelistConstraint(error: ValidationError): ValidationError {
  const constraints = error.constraints
    ? Object.fromEntries(
        Object.entries(error.constraints).map(([key, message]) => [
          key,
          key === WHITELIST_CONSTRAINT
            ? UNKNOWN_FIELD_MESSAGE(error.property)
            : message,
        ]),
      )
    : error.constraints;

  return {
    ...error,
    constraints,
    children: error.children?.map(translateWhitelistConstraint),
  };
}

/**
 * Applique à l'application tout ce qui n'est pas déclaré dans un module :
 * hooks d'arrêt, confiance au proxy, en-têtes de sécurité, préfixe global,
 * parseurs de corps, pipe de validation, filtre d'erreur et CORS.
 *
 * Vit hors de `main.ts` pour être **testable** : `main.ts` n'est jamais
 * exécuté par les tests (il appelle `listen`), donc tout réglage qui y resterait
 * ne serait couvert par aucune preuve. Voir `app-setup.spec.ts`.
 */
export function setupApp(
  app: NestExpressApplication,
  configService: ConfigService,
): void {
  // Sans ceci, Nest n'appelle jamais `onModuleDestroy`/`onApplicationShutdown`
  // sur SIGTERM - le relais SMTP (B6/S5) ne fermerait donc jamais ses
  // serveurs à l'arrêt du conteneur, laissant des connexions en cours se
  // faire trancher par SIGKILL plutôt que de recevoir un `421` propre.
  // Effet global assumé (A17) : Prisma, Redis et BullMQ s'arrêtent désormais
  // eux aussi sur SIGTERM - vérifié qu'aucun de ces hooks existants ne jette.
  app.enableShutdownHooks();

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

  app.use(
    helmet({
      // Deux ans, sous-domaines compris, et éligible à la liste de préchargement
      // des navigateurs : `api.zendou.app` ne doit jamais être joignable en
      // clair, pas même au tout premier appel.
      hsts: {
        maxAge: 63072000,
        includeSubDomains: true,
        preload: true,
      },
      // Cette API ne rend que du JSON : elle n'a besoin d'aucune source, et
      // aucune page ne doit pouvoir l'encadrer. On repart donc de zéro
      // (`useDefaults: false`) plutôt que d'hériter des directives pensées
      // pour un site web.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
        },
      },
      // `same-site` et non `same-origin` : `zendou.app` (front) et
      // `api.zendou.app` (cette API) sont deux origines distinctes mais
      // partagent le même site enregistrable. `same-origin` ferait refuser au
      // navigateur toute lecture faite depuis le front en mode `no-cors`
      // (préchargements, balises, `sendBeacon`), alors que ce sont les deux
      // moitiés d'un même produit. Un site tiers, lui, reste bloqué.
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Ceinture et bretelles : helmet retire déjà `X-Powered-By`, mais si un jour
  // sa configuration changeait, Express le reposerait en silence. Annoncer sa
  // pile à l'attaquant ne sert qu'à lui.
  app.disable('x-powered-by');

  app.setGlobalPrefix('v1', {
    exclude: ['health'],
  });

  // La limite Express par défaut (100 Ko) est en deçà des 500 Ko autorisés
  // pour `html`/`text` sur `POST /v1/emails`.
  app.useBodyParser('json', { limit: '2mb', type: JSON_BODY_TYPES });

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Un champ inconnu n'est plus silencieusement retiré mais refusé : un
      // client qui croit envoyer `role: "ADMIN"` ou `credits: 1000` doit
      // l'apprendre par un 400, pas se voir servir un 200 trompeur.
      forbidNonWhitelisted: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );

  // Uniformise le corps de toutes les réponses d'erreur : `message` toujours
  // une chaîne, `errors` toujours un tableau non vide. Sans lui, un échec
  // class-validator (agrégé en tableau par le pipe ci-dessus) et un
  // `throw new BadRequestException("…")` rendaient la même phrase métier sous
  // deux types différents - voir `common/http-exception.filter.ts`.
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableCors({
    origin: configService.get<string>('FRONTEND_ORIGIN'),
    credentials: true,
    exposedHeaders: CORS_EXPOSED_HEADERS,
  });
}

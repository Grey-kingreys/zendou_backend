import { z } from 'zod';
import { API_KEY_FAILURES_PER_MINUTE_DEFAULT } from '../api-keys/api-keys.constants';
import { LOGIN_LOCKOUT_DEFAULTS } from '../auth/auth.constants';
import {
  DEFAULT_WELCOME_CREDITS,
  PHONE_ALLOWED_CHARS_REGEX,
  PHONE_MAX_DIGITS,
  PHONE_MIN_DIGITS,
} from '../billing/billing.constants';
import { parseEmailAddress } from '../emails/email-address';
import { MAX_RAW_MESSAGE_BYTES } from '../emails/emails.constants';
import {
  DEFAULT_TRUST_PROXY_HOPS,
  RATE_LIMIT_DEFAULTS,
} from '../rate-limit/rate-limit.constants';
import {
  SMTP_DEFAULT_AUTH_FAILURE_WINDOW_MS,
  SMTP_DEFAULT_AUTH_STUFFING_USERNAME_THRESHOLD,
  SMTP_DEFAULT_BIND_ADDRESS,
  SMTP_DEFAULT_CLOSE_TIMEOUT_MS,
  SMTP_DEFAULT_CONNECTION_WINDOW_MS,
  SMTP_DEFAULT_MAX_AUTH_FAILURES_PER_CONNECTION,
  SMTP_DEFAULT_MAX_CLIENTS,
  SMTP_DEFAULT_MAX_CONNECTIONS_PER_IP,
  SMTP_DEFAULT_MAX_MESSAGES_PER_CONNECTION,
  SMTP_DEFAULT_MAX_RECIPIENTS,
  SMTP_DEFAULT_MAX_REFUSED_RECIPIENTS_PER_CONNECTION,
  SMTP_DEFAULT_PORTS_STARTTLS,
  SMTP_DEFAULT_PORTS_TLS,
  SMTP_DEFAULT_SOCKET_TIMEOUT_MS,
  SMTP_NO_LISTENING_PORT_MESSAGE,
  SMTP_TLS_CERTIFICATE_REQUIRED_MESSAGE,
} from '../smtp/smtp-relay.constants';

/** `true`, `1`, `yes`, `on` (insensible à la casse) valent vrai ; tout le reste faux. */
const TRUTHY_VALUES = ['1', 'true', 'yes', 'on'];

/** Nom par défaut du compte admin créé au démarrage si `ADMIN_NAME` est absente. */
export const DEFAULT_ADMIN_NAME = 'Administrateur Zendou';

/** Une chaîne vide (ou faite d'espaces) équivaut à une variable absente. */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * Booléen lu depuis l'environnement, avec défaut explicite.
 *
 * `emptyToUndefined` est appliqué en amont pour que `VARIABLE=` (laissée vide
 * dans un `.env`) vaille « absente », donc le défaut — la convention maison du
 * fichier. Sans lui, une variable dont le défaut est **vrai** basculerait à
 * faux au premier `.env` mal recopié, ce qui désarmerait une protection en
 * silence.
 */
const booleanFromEnv = (defaultValue: boolean) =>
  z
    .preprocess(
      emptyToUndefined,
      z.union([z.boolean(), z.string()]).default(defaultValue),
    )
    .transform((value) =>
      typeof value === 'boolean'
        ? value
        : TRUTHY_VALUES.includes(value.trim().toLowerCase()),
    );

/**
 * Entier positif lu depuis l'environnement, avec défaut. Une variable laissée
 * vide dans un `.env` (`RATE_LIMIT_LOGIN_PER_MINUTE=`) doit valoir « absente »
 * et non « zéro », sans quoi la limite tomberait silencieusement à 0 et
 * bloquerait tout le monde.
 */
const positiveIntFromEnv = (defaultValue: number) =>
  z
    .preprocess(emptyToUndefined, z.coerce.number().int().positive().optional())
    .default(defaultValue);

/**
 * Comme `positiveIntFromEnv`, mais `0` est une valeur légitime. Réservé aux
 * réglages où « zéro » veut dire « désactivé » et non « tout bloquer » —
 * aujourd'hui `WELCOME_CREDITS` seul : mettre `0` coupe le crédit de
 * bienvenue sans toucher au code.
 */
const nonNegativeIntFromEnv = (defaultValue: number) =>
  z
    .preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional())
    .default(defaultValue);

/**
 * Liste de ports TCP séparés par des virgules (`« 587,2525 »` → `[587, 2525]`).
 *
 * **Seule variable du fichier où une chaîne vide n'équivaut pas à « absente »**,
 * et c'est délibéré : `SMTP_PORTS_TLS=` doit pouvoir vouloir dire « ne pas
 * écouter en TLS implicite », ce qu'`emptyToUndefined` rendrait inexprimable
 * puisqu'il ferait retomber sur le défaut `465`. Le raisonnement qui fonde la
 * convention maison — « vide ne doit jamais dégrader silencieusement » — est
 * préservé autrement : le `refine` plus bas refuse le démarrage si le relais
 * est activé alors que **les deux** listes sont vides. On peut donc renoncer à
 * une famille de ports, jamais à toutes, et jamais en silence.
 */
/**
 * Port 25 : transit MX entre serveurs, jamais soumission cliente. Le relais
 * de Zendou n'a aucune raison de l'écouter, et l'écouter serait un risque -
 * un port 25 ouvert est immédiatement sondé, et un relais qui y répond finit
 * sur les listes noires. La règle était déjà écrite dans la documentation
 * (A6) ; elle devient ici une règle de configuration, vérifiée au démarrage.
 */
const MX_TRANSIT_PORT = 25;

/** Message de refus du port 25, dans les deux listes de ports. */
export const SMTP_PORT_25_REFUSED_MESSAGE =
  "Le port 25 (transit MX) n'est jamais écouté par le relais SMTP : utilisez 587, 2525 ou 465.";

const portListFromEnv = (defaultValue: string) =>
  z
    .string()
    .default(defaultValue)
    .transform((raw, ctx) => {
      const ports: number[] = [];

      for (const entry of raw.split(',')) {
        const trimmed = entry.trim();

        if (trimmed === '') {
          continue;
        }

        const port = Number(trimmed);

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          ctx.addIssue({
            code: 'custom',
            message: `« ${trimmed} » n'est pas un port TCP valide (entier de 1 à 65535)`,
          });
          continue;
        }

        if (port === MX_TRANSIT_PORT) {
          ctx.addIssue({
            code: 'custom',
            message: SMTP_PORT_25_REFUSED_MESSAGE,
          });
          continue;
        }

        if (ports.includes(port)) {
          ctx.addIssue({
            code: 'custom',
            message: `le port ${port} est indiqué plusieurs fois`,
          });
          continue;
        }

        ports.push(port);
      }

      return ports;
    });

/**
 * Nom de domaine nu : suite de libellés alphanumériques séparés par des
 * points. Ni schéma (`https://`), ni port (`:443`), ni chemin - un `Domain=`
 * de cookie n'accepte rien de tout cela, et un navigateur qui reçoit une
 * valeur mal formée ignore le cookie **en silence**, ce qui déconnecterait
 * tout le monde sans une ligne d'erreur nulle part.
 */
const COOKIE_DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Normalise `SESSION_COOKIE_DOMAIN` : espaces retirés, minuscules (les noms de
 * domaine sont insensibles à la casse), point initial toléré et retiré
 * (`.zendou.app` est la notation RFC 2109, que la RFC 6265 a remplacée par la
 * forme nue), et vide traité comme absent selon la convention du fichier.
 */
const normalizeCookieDomain = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase().replace(/^\./, '');

  return normalized === '' ? undefined : normalized;
};

/**
 * Numéro Mobile Money Zendou (`MOBILE_MONEY_ORANGE_NUMBER`,
 * `MOBILE_MONEY_MTN_NUMBER`, B22) : même contrainte de forme que le numéro du
 * client dans `CreateTopUpRequestDto` - chiffres, espaces et « + »
 * uniquement, 8 à 15 chiffres (`PHONE_ALLOWED_CHARS_REGEX`/
 * `PHONE_MIN_DIGITS`/`PHONE_MAX_DIGITS`, `billing.constants.ts`), pas une
 * seconde règle à tenir synchronisée. **Optionnelle** : absente, la méthode
 * correspondante n'est simplement pas proposée
 * (`BillingService.listPaymentMethods`) - mais présente et mal formée, elle
 * fait échouer le démarrage plutôt que d'être affichée telle quelle à un
 * client qui s'apprête à y envoyer de l'argent.
 */
const mobileMoneyNumberFromEnv = () =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .refine(
        (value) => {
          if (!PHONE_ALLOWED_CHARS_REGEX.test(value)) {
            return false;
          }

          const digitCount = (value.match(/\d/g) ?? []).length;
          return (
            digitCount >= PHONE_MIN_DIGITS && digitCount <= PHONE_MAX_DIGITS
          );
        },
        {
          message: `doit être un numéro valide : chiffres, espaces et « + » uniquement, avec ${PHONE_MIN_DIGITS} à ${PHONE_MAX_DIGITS} chiffres`,
        },
      )
      .optional(),
  );

const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().url(),

  /**
   * Domaine porté par le cookie de session (`Domain=zendou.app`).
   *
   * **Optionnelle.** Absente, le cookie reste *hôte-seul* : seul l'hôte qui l'a
   * posé (`api.zendou.app`) le reçoit - le comportement historique. Renseignée
   * avec le domaine parent, le cookie est envoyé à `zendou.app` **et** à
   * `api.zendou.app`, ce qui est la seule façon pour le proxy Next servi sur
   * `zendou.app` de lire la session. En production, son absence est signalée
   * par un avertissement au démarrage du contrôleur d'authentification.
   *
   * Valeur attendue : un nom de domaine nu (`zendou.app`). Un schéma ou un
   * port (`https://zendou.app`, `zendou.app:443`) est refusé au démarrage : le
   * navigateur, lui, se contenterait d'ignorer le cookie sans rien dire.
   */
  SESSION_COOKIE_DOMAIN: z.preprocess(
    normalizeCookieDomain,
    z
      .string()
      .regex(
        COOKIE_DOMAIN_PATTERN,
        'doit être un nom de domaine nu, sans schéma ni port ni chemin (exemple : zendou.app)',
      )
      .optional(),
  ),

  /**
   * Nombre de proxys inverses devant l'application (Traefik sous Dokploy en
   * pose un). Détermine `trust proxy` côté Express, donc l'IP retenue dans
   * `X-Forwarded-For`. `0` = aucun proxy : l'en-tête est alors ignoré, car
   * n'importe qui pourrait le forger. Mal réglée, cette valeur ferait
   * partager un unique compteur à tous les clients — la limitation de débit
   * se transformerait en déni de service global.
   */
  TRUST_PROXY_HOPS: z
    .preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(0).max(10).optional(),
    )
    .default(DEFAULT_TRUST_PROXY_HOPS),

  // ─── Limitation de débit (valeurs par défaut : rate-limit.constants.ts) ───
  RATE_LIMIT_DEFAULT_PER_MINUTE: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.DEFAULT_PER_MINUTE,
  ),
  RATE_LIMIT_LOGIN_PER_MINUTE: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.LOGIN_PER_MINUTE,
  ),
  RATE_LIMIT_LOGIN_PER_HOUR: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.LOGIN_PER_HOUR,
  ),
  RATE_LIMIT_REGISTER_PER_HOUR: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.REGISTER_PER_HOUR,
  ),
  /**
   * Plafond journalier de l'inscription (E2), par IP et par adresse visée.
   * La fenêtre horaire seule laisse créer 72 comptes par jour depuis une même
   * IP à qui sait attendre - voir `REGISTER_PER_DAY` dans
   * `rate-limit.constants.ts`.
   */
  RATE_LIMIT_REGISTER_PER_DAY: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.REGISTER_PER_DAY,
  ),
  RATE_LIMIT_CHANGE_PASSWORD_PER_HOUR: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.CHANGE_PASSWORD_PER_HOUR,
  ),
  RATE_LIMIT_EMAILS_PER_MINUTE: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.EMAILS_PER_MINUTE,
  ),
  RATE_LIMIT_DOMAIN_CHECK_PER_HOUR: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.DOMAIN_CHECK_PER_HOUR,
  ),
  RATE_LIMIT_DNS_CHECK_PER_HOUR: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.DNS_CHECK_PER_HOUR,
  ),
  RATE_LIMIT_SNS_PER_MINUTE: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.SNS_PER_MINUTE,
  ),
  /**
   * Rapports de violation CSP (`POST /v1/csp-report`), comptés par IP. Route
   * publique dont le seul coût est le journal : c'est lui qu'on protège.
   */
  RATE_LIMIT_CSP_REPORT_PER_MINUTE: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.CSP_REPORT_PER_MINUTE,
  ),
  RATE_LIMIT_RESEND_CONFIRMATION_PER_HOUR: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.RESEND_CONFIRMATION_PER_HOUR,
  ),

  // ─── Verrouillage progressif de la connexion (auth/login-lockout.service) ───

  /**
   * Échecs consécutifs tolérés sur une même adresse email avant blocage. La
   * limitation de débit borne le *rythme* des tentatives ; ce compteur-ci
   * borne l'*acharnement* sur un compte donné, quelle que soit l'IP d'origine.
   */
  LOGIN_LOCKOUT_THRESHOLD: positiveIntFromEnv(LOGIN_LOCKOUT_DEFAULTS.THRESHOLD),

  /** Durée du premier blocage, en secondes. Elle double à chaque palier. */
  LOGIN_LOCKOUT_BASE_SECONDS: positiveIntFromEnv(
    LOGIN_LOCKOUT_DEFAULTS.BASE_SECONDS,
  ),

  /**
   * Plafond du doublement, en secondes. Au-delà, le verrouillage cesserait de
   * protéger le titulaire du compte pour se mettre à le punir : n'importe qui
   * peut faire échouer des connexions sur l'adresse d'un tiers.
   */
  LOGIN_LOCKOUT_MAX_SECONDS: positiveIntFromEnv(
    LOGIN_LOCKOUT_DEFAULTS.MAX_SECONDS,
  ),

  /**
   * Durée de vie du compteur d'échecs, en secondes : cinq fautes de frappe
   * étalées sur la journée ne doivent rien déclencher.
   */
  LOGIN_LOCKOUT_WINDOW_SECONDS: positiveIntFromEnv(
    LOGIN_LOCKOUT_DEFAULTS.WINDOW_SECONDS,
  ),

  /**
   * Échecs d'authentification par clé API tolérés pour une même IP en une
   * minute (lot C). Au-delà, cette IP reçoit un 429 pendant une minute.
   *
   * Seuls les ÉCHECS sont comptés : une clé valide passe toujours, même
   * derrière une IP bloquée - voir `ApiKeyAuthGuard`. Le défaut vit dans
   * `api-keys.constants.ts`, avec le raisonnement.
   */
  RATE_LIMIT_API_KEY_FAILURES_PER_MINUTE: positiveIntFromEnv(
    API_KEY_FAILURES_PER_MINUTE_DEFAULT,
  ),

  // AWS SES / SNS — optionnelles pour l'instant (pas de module d'envoi)
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),
  SES_SMTP_HOST: z.string().optional(),
  SES_SMTP_PORT: z.string().optional(),
  SES_SMTP_USER: z.string().optional(),
  SES_SMTP_PASSWORD: z.string().optional(),
  SES_SNS_TOPIC_ARN: z.string().optional(),

  // Contournement de la vérification de signature SNS (tests locaux / démo).
  // Interdit en production : sans signature, n'importe qui peut forger un
  // bounce et faire suppressor des adresses arbitraires.
  SNS_SKIP_SIGNATURE_VALIDATION: booleanFromEnv(false),

  /**
   * Poivre des empreintes de secrets porteurs : clés API (`ApiKey.keyHash`) et
   * mots de passe SMTP (`SmtpCredential.secretHash`). Voir
   * `api-keys/secret-hashing.service.ts`.
   *
   * **Obligatoire en production** (voir le `refine` plus bas) : sans lui, une
   * fuite de la base suffit à vérifier une clé devinée hors ligne. Optionnelle
   * ailleurs - absente, le hachage reste le SHA-256 historique, exactement
   * comme avant E3.
   *
   * Minimum 32 caractères : un poivre plus court affaiblirait la clé HMAC
   * au point de rendre l'exercice décoratif. À générer avec
   * `openssl rand -hex 32`.
   */
  API_KEY_PEPPER: z.preprocess(
    emptyToUndefined,
    z.string().min(32, 'doit contenir au moins 32 caractères').optional(),
  ),

  /**
   * Clé secrète Cloudflare Turnstile (`POST /v1/auth/register` uniquement).
   * **Optionnelle** : absente ou vide (y compris une chaîne blanche), le
   * captcha est **désactivé** — utile en dev/tests, et comme débrayage
   * d'urgence en production si le widget gêne des utilisateurs sur mauvais
   * réseau (il suffit de retirer la variable et de redéployer). Voir
   * `src/captcha/captcha.service.ts`.
   */
  TURNSTILE_SECRET_KEY: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),

  // Compte administrateur créé automatiquement au démarrage (voir SeedModule).
  // Entièrement optionnelles : sans elles, l'app démarre normalement et le
  // seed se contente de logger qu'il est ignoré.
  ADMIN_EMAIL: z.preprocess(
    emptyToUndefined,
    z.string().trim().email('doit être une adresse email valide').optional(),
  ),
  ADMIN_PASSWORD: z.preprocess(
    emptyToUndefined,
    z.string().min(12, 'doit contenir au moins 12 caractères').optional(),
  ),
  ADMIN_NAME: z
    .preprocess(emptyToUndefined, z.string().trim().optional())
    .default(DEFAULT_ADMIN_NAME),

  /**
   * Destinataire des alertes d'exploitation — aujourd'hui l'expiration du
   * certificat TLS du relais SMTP (B6/H1). **Optionnelle** : absente, on
   * retombe sur `ADMIN_EMAIL` ; absentes toutes les deux, la surveillance se
   * contente de journaliser et le démarrage émet un avertissement.
   *
   * Distincte d'`ADMIN_EMAIL` parce que les deux rôles n'ont pas de raison de
   * coïncider : l'un ouvre le tableau de bord d'administration, l'autre reçoit
   * les alertes techniques (et pourrait être une liste de diffusion). Le
   * compte destinataire doit exister dans Zendou — `sendSystem` trace la ligne
   * `Email` sur un compte, comme tout envoi.
   */
  ALERTS_EMAIL_TO: z.preprocess(
    emptyToUndefined,
    z.string().trim().email('doit être une adresse email valide').optional(),
  ),

  // ─── Emails système (confirmation d'adresse) ───

  /**
   * Adresse d'expédition de **tous** les emails envoyés par Zendou lui-même
   * (confirmation d'adresse aujourd'hui). Son domaine doit être vérifié —
   * chez SES **et** dans la table `Domain` de Zendou : l'exemption des envois
   * système ne relâche pas cette exigence (`EmailsService.sendSystem`).
   *
   * Accepte les deux formes reconnues par `parseEmailAddress`
   * (`emails/email-address.ts`) : `adresse@domaine` nue, ou avec nom
   * d'affichage `Nom <adresse@domaine>` (nom éventuellement entre
   * guillemets). C'est la même règle que celle utilisée à l'envoi — pas de
   * duplication.
   *
   * Configuration pure, rien en dur : le basculement de `mail.kingreys.fr`
   * (bêta) vers un domaine Zendou est un changement de variable, pas de code.
   * Obligatoire en production — voir le `refine` plus bas.
   */
  SYSTEM_EMAIL_FROM: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .refine((value) => parseEmailAddress(value) !== null, {
        message:
          "doit être une adresse email valide, éventuellement précédée d'un nom d'affichage (Nom <adresse@domaine>)",
      })
      .optional(),
  ),

  /**
   * Base des liens contenus dans les emails système :
   * `${APP_BASE_URL}/confirmation?token=…`. Absente, on retombe sur
   * `FRONTEND_ORIGIN` — c'est la même application dans la quasi-totalité des
   * déploiements, et un lien de confirmation qui pointe vers le front est le
   * comportement attendu. La variable existe pour les cas où les deux
   * divergent (domaine marketing distinct du domaine applicatif).
   */
  APP_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().trim().url().optional(),
  ),

  /**
   * Crédits offerts **une seule fois**, au moment de la confirmation de
   * l'adresse (jamais à l'inscription : sinon créer des comptes deviendrait
   * une capacité de spam gratuite sur notre compte SES, hors bac à sable).
   * Variable et non constante : la grille tarifaire est marquée non finale au
   * cahier §12. `0` désactive le bonus.
   */
  WELCOME_CREDITS: nonNegativeIntFromEnv(DEFAULT_WELCOME_CREDITS),

  // ─── Mobile Money (numéros Zendou pour la recharge client, B22) ───

  /**
   * Numéro Zendou Orange Money vers lequel le client envoie sa recharge.
   * Donnée de configuration, pas une constante de code : ce numéro dépend
   * d'un compte marchand ouvert indépendamment d'un déploiement de code.
   * Voir `mobileMoneyNumberFromEnv` ci-dessus pour la validation de forme.
   */
  MOBILE_MONEY_ORANGE_NUMBER: mobileMoneyNumberFromEnv(),

  /** Numéro Zendou MTN MoMo. Mêmes règles que `MOBILE_MONEY_ORANGE_NUMBER`. */
  MOBILE_MONEY_MTN_NUMBER: mobileMoneyNumberFromEnv(),

  /**
   * Nom du bénéficiaire affiché au client à côté du numéro configuré, pour
   * qu'il vérifie l'identité du compte avant de valider son transfert.
   * Partagé entre les deux méthodes ci-dessus. **Optionnel** : absent,
   * `accountName` vaut `null` sur `GET /v1/billing/payment-methods` - aucune
   * méthode n'est bloquée pour son absence, il ne fait que renforcer la
   * confiance du client quand il est renseigné.
   */
  MOBILE_MONEY_ACCOUNT_NAME: z.preprocess(
    emptyToUndefined,
    z.string().trim().optional(),
  ),

  // ─── Adresse d'expédition de test (bac à sable, façon Resend) ───

  /**
   * Adresse d'expédition du mode « bac à sable » (B20) : permet à un client
   * fraîchement inscrit d'envoyer **immédiatement**, avant même d'avoir
   * vérifié un domaine — exactement le rôle d'`onboarding@resend.dev` chez
   * Resend. En échange, `EmailsService.send` restreint le destinataire à la
   * seule adresse du compte appelant (`user.email`, déjà confirmée) : voir
   * `TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE` dans `emails.constants.ts`
   * pour le raisonnement complet (protection de la réputation du domaine
   * d'expédition partagé, qui expédie aussi les confirmations d'inscription).
   *
   * Accepte les deux mêmes formes que `SYSTEM_EMAIL_FROM`, validées par le
   * même `parseEmailAddress` (`emails/email-address.ts`, source de vérité
   * unique — pas de seconde regex) : `adresse@domaine` nue, ou
   * `Nom <adresse@domaine>`.
   *
   * **Optionnelle partout, y compris en production** : absente, ce mode est
   * simplement indisponible et tout envoi retombe sur l'exigence normale de
   * domaine vérifié et possédé par le client — aucune régression possible.
   * En bêta : une adresse sous `mail.kingreys.fr`, le seul domaine vérifié
   * chez SES ; le domaine Zendou définitif ne demandera qu'un changement de
   * variable.
   */
  TEST_EMAIL_FROM: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .refine((value) => parseEmailAddress(value) !== null, {
        message:
          "doit être une adresse email valide, éventuellement précédée d'un nom d'affichage (Nom <adresse@domaine>)",
      })
      .optional(),
  ),

  // ─── Relais SMTP entrant (B6 — voir docs/plans/B6-RELAIS-SMTP.md) ───

  /**
   * Interrupteur général du relais SMTP. **Faux par défaut**, donc inerte dans
   * tous les environnements existants, production comprise : le module
   * n'ouvre aucun port, ne lit aucun fichier et ne pose aucun observateur tant
   * que cette variable n'est pas explicitement activée. Le jour de la mise en
   * service, ce sera un ajout de variable et une republication de ports (S14),
   * pas un déploiement de code.
   */
  SMTP_RELAY_ENABLED: booleanFromEnv(false),

  /**
   * Ports écoutés en STARTTLS (§1.2). Défaut `587,2525` : 587 est le port de
   * soumission que tous les clients tentent en premier, 2525 un alias de repli
   * gratuit si un FAI guinéen filtre 587. Le port 25 n'a pas sa place ici
   * (A6) : c'est du transit MX, pas de la soumission.
   */
  SMTP_PORTS_STARTTLS: portListFromEnv(SMTP_DEFAULT_PORTS_STARTTLS),

  /** Ports écoutés en TLS implicite (§1.2). Défaut `465` (RFC 8314). */
  SMTP_PORTS_TLS: portListFromEnv(SMTP_DEFAULT_PORTS_TLS),

  /**
   * Interface d'écoute. Toutes par défaut — sous Dokploy c'est la publication
   * de port en `mode: host` qui décide de l'exposition (A18). Les tests
   * d'intégration s'en servent pour n'écouter que sur la boucle locale.
   */
  SMTP_BIND_ADDRESS: z
    .preprocess(emptyToUndefined, z.string().trim().min(1).optional())
    .default(SMTP_DEFAULT_BIND_ADDRESS),

  /**
   * Chemins du certificat et de la clé privée du relais (§1.4). Fichiers
   * produits par certbot/lego sur l'hôte et montés en lecture seule : Traefik
   * garde les siens dans un `acme.json` qu'il n'expose pas. **Obligatoires en
   * production dès que le relais est activé** — voir le `refine` plus bas.
   * Absents hors production, `smtp-server` sert son certificat auto-signé
   * intégré, ce qui suffit au développement et n'est jamais toléré ailleurs.
   */
  SMTP_TLS_CERT_PATH: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).optional(),
  ),
  SMTP_TLS_KEY_PATH: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).optional(),
  ),

  /**
   * Connexions simultanées par instance `SMTPServer`. Plafond global qui
   * protège l'event loop partagé avec l'API (§1.1) ; le plafond **par IP**,
   * lui, relève de S9.
   */
  SMTP_MAX_CLIENTS: positiveIntFromEnv(SMTP_DEFAULT_MAX_CLIENTS),

  /** Inactivité tolérée sur une connexion avant fermeture (§5). */
  SMTP_SOCKET_TIMEOUT_MS: positiveIntFromEnv(SMTP_DEFAULT_SOCKET_TIMEOUT_MS),

  /** Sursis accordé aux connexions en cours lors d'un arrêt gracieux. */
  SMTP_CLOSE_TIMEOUT_MS: positiveIntFromEnv(SMTP_DEFAULT_CLOSE_TIMEOUT_MS),

  // ─── Pipeline du relais (B6/S7 — §4.5 et §4.7 du plan) ───

  /**
   * Taille maximale d'un message MIME reçu par le relais, en octets. Annoncée
   * par la capacité `SIZE` de l'EHLO — le client sait donc **avant** d'envoyer
   * — et appliquée pendant le flux `DATA`.
   *
   * Défaut : 10 Mo, `min(10 Mo, limite SES)` — voir `MAX_RAW_MESSAGE_BYTES`
   * (`emails.constants.ts`) pour la source AWS et le raisonnement complet.
   * Décision produit B4 du §8 : le porteur peut descendre sans toucher au code.
   */
  SMTP_MAX_MESSAGE_BYTES: positiveIntFromEnv(MAX_RAW_MESSAGE_BYTES),

  /**
   * Destinataires acceptés pour un même message (§4.7). Au-delà : `452 4.5.3`
   * sur le `RCPT TO` excédentaire. Chaque destinataire est facturé un crédit,
   * comme un appel API — ce plafond borne donc aussi le coût d'un seul message.
   */
  SMTP_MAX_RECIPIENTS: positiveIntFromEnv(SMTP_DEFAULT_MAX_RECIPIENTS),

  // ─── Anti-abus du relais SMTP (B6/S9 — §5 du plan) ───

  /**
   * Les limites **par IP** (connexions, échecs d'authentification) sont-elles
   * appliquées ? **Vraie par défaut** — c'est une protection, on ne l'éteint
   * pas par omission.
   *
   * À passer à `false` **uniquement** si l'IP source n'arrive pas intacte
   * jusqu'au processus. C'est le piège du §1.3 : Dokploy s'appuie sur Docker
   * Swarm, et en mode `ingress` le *routing mesh* réécrit l'adresse source —
   * toutes les connexions SMTP arriveraient avec celle de la passerelle. Les
   * limites par IP s'effondreraient alors en **un compteur unique partagé par
   * tout Internet**, où le premier client à saturer ferait taire tous les
   * autres. Le §5 tranche : « une limite qui compte tout le monde ensemble est
   * pire qu'une limite absente » — on la désactive franchement, avec un
   * avertissement au démarrage, plutôt que de la laisser à faux.
   *
   * La bonne correction reste de publier les ports en `mode: host` (A18) pour
   * que `session.remoteAddress` soit la vraie IP ; cette variable est le
   * garde-fou en attendant, pas la solution. Les limites **par utilisateur**
   * et **par connexion** ne dépendent pas de l'IP et restent actives.
   */
  SMTP_IP_LIMITS_ENABLED: booleanFromEnv(true),

  /** Connexions acceptées depuis une même IP par `SMTP_CONNECTION_WINDOW_MS`. */
  SMTP_MAX_CONNECTIONS_PER_IP: positiveIntFromEnv(
    SMTP_DEFAULT_MAX_CONNECTIONS_PER_IP,
  ),

  /** Fenêtre du compteur de connexions par IP (défaut : une minute). */
  SMTP_CONNECTION_WINDOW_MS: positiveIntFromEnv(
    SMTP_DEFAULT_CONNECTION_WINDOW_MS,
  ),

  /**
   * Échecs d'authentification tolérés sur **une même connexion** ; le suivant
   * reçoit `421 4.7.0` et voit son socket fermé (§4.4).
   */
  SMTP_MAX_AUTH_FAILURES_PER_CONNECTION: positiveIntFromEnv(
    SMTP_DEFAULT_MAX_AUTH_FAILURES_PER_CONNECTION,
  ),

  /**
   * Fenêtre des compteurs d'échecs d'AUTH par IP et par nom d'utilisateur.
   * Ces compteurs **ne bloquent pas** : ils alimentent l'observation et la
   * détection de bourrinage (§5, « pas de verrouillage de compte »).
   */
  SMTP_AUTH_FAILURE_WINDOW_MS: positiveIntFromEnv(
    SMTP_DEFAULT_AUTH_FAILURE_WINDOW_MS,
  ),

  /**
   * Noms d'utilisateur distincts ratés par une même IP, dans la fenêtre
   * ci-dessus, avant la ligne d'alerte « bourrinage d'identifiants » (§5).
   */
  SMTP_AUTH_STUFFING_USERNAME_THRESHOLD: positiveIntFromEnv(
    SMTP_DEFAULT_AUTH_STUFFING_USERNAME_THRESHOLD,
  ),

  /**
   * Protection de rafale du canal SMTP, comptée **par utilisateur** — jamais
   * par IP : en Guinée les abonnés mobiles partagent les mêmes IP publiques
   * (NAT opérateur), le raisonnement de `rate-limit.constants.ts` s'applique
   * mot pour mot (§5).
   *
   * Le défaut est **la même valeur** que `RATE_LIMIT_EMAILS_PER_MINUTE`, lue
   * dans la même constante : les deux canaux doivent offrir la même tolérance.
   * Ce sont en revanche deux budgets **séparés**, à dessein — un client qui
   * utilise l'API et le relais ne doit pas voir chaque canal amputé par
   * l'autre.
   */
  SMTP_EMAILS_PER_MINUTE: positiveIntFromEnv(
    RATE_LIMIT_DEFAULTS.EMAILS_PER_MINUTE,
  ),

  /** Messages acceptés sur une même connexion avant `421` + fermeture (§5). */
  SMTP_MAX_MESSAGES_PER_CONNECTION: positiveIntFromEnv(
    SMTP_DEFAULT_MAX_MESSAGES_PER_CONNECTION,
  ),

  /**
   * Destinataires **refusés** tolérés sur une même connexion avant `421` +
   * fermeture — anti-moissonnage d'adresses (§5).
   */
  SMTP_MAX_REFUSED_RECIPIENTS_PER_CONNECTION: positiveIntFromEnv(
    SMTP_DEFAULT_MAX_REFUSED_RECIPIENTS_PER_CONNECTION,
  ),
});

export const envSchema = baseEnvSchema
  .refine(
    (env) =>
      !(env.NODE_ENV === 'production' && env.SNS_SKIP_SIGNATURE_VALIDATION),
    {
      path: ['SNS_SKIP_SIGNATURE_VALIDATION'],
      message:
        'ne peut pas être activé quand NODE_ENV=production (signature SNS obligatoire)',
    },
  )
  .refine((env) => Boolean(env.ADMIN_EMAIL) === Boolean(env.ADMIN_PASSWORD), {
    path: ['ADMIN_EMAIL'],
    message:
      'ADMIN_EMAIL et ADMIN_PASSWORD doivent être renseignées ensemble (configuration admin incomplète)',
  })
  // Sans adresse d'expédition système, aucun email de confirmation ne part :
  // les nouveaux comptes restent non confirmés pour toujours, donc incapables
  // d'envoyer ou de créer une clé. Échouer bruyamment au démarrage vaut mieux
  // que livrer un tunnel d'inscription qui ne mène nulle part. Hors
  // production, l'absence est tolérée (dev et tests n'expédient rien).
  .refine(
    (env) => env.NODE_ENV !== 'production' || Boolean(env.SYSTEM_EMAIL_FROM),
    {
      path: ['SYSTEM_EMAIL_FROM'],
      message:
        'est obligatoire quand NODE_ENV=production (sans elle, aucun email de confirmation ne peut partir et aucun compte créé ne peut être confirmé)',
    },
  )
  // E3 - le poivre est ce qui empêche une fuite de la base de suffire à
  // vérifier une clé devinée hors ligne. En production, il n'est pas
  // facultatif : démarrer sans lui reviendrait à publier un service dont
  // toutes les empreintes sont recalculables par quiconque lit la table.
  .refine(
    (env) => env.NODE_ENV !== 'production' || Boolean(env.API_KEY_PEPPER),
    {
      path: ['API_KEY_PEPPER'],
      message:
        'est obligatoire quand NODE_ENV=production (sans lui, une fuite de la base suffit à vérifier une clé API ou un mot de passe SMTP deviné hors ligne)',
    },
  )
  // §1.4 / A19 — règle dure et testable : en production, un relais SMTP activé
  // sans certificat ne démarre pas. Un serveur de soumission qui accepterait
  // des identifiants en clair sur Internet est un incident, pas une
  // dégradation ; mieux vaut un déploiement qui échoue bruyamment.
  .refine(
    (env) =>
      !(
        env.NODE_ENV === 'production' &&
        env.SMTP_RELAY_ENABLED &&
        !(env.SMTP_TLS_CERT_PATH && env.SMTP_TLS_KEY_PATH)
      ),
    {
      path: ['SMTP_TLS_CERT_PATH'],
      message: SMTP_TLS_CERTIFICATE_REQUIRED_MESSAGE,
    },
  )
  // §6 / A16 — « un relais silencieusement mort est le pire des états ». Une
  // configuration qui active le relais en vidant les deux listes de ports
  // produirait exactement cela : le service démarre, les journaux sont calmes,
  // et pas une seule connexion n'est jamais acceptée.
  .refine(
    (env) =>
      !env.SMTP_RELAY_ENABLED ||
      env.SMTP_PORTS_STARTTLS.length + env.SMTP_PORTS_TLS.length > 0,
    {
      path: ['SMTP_PORTS_STARTTLS'],
      message: SMTP_NO_LISTENING_PORT_MESSAGE,
    },
  );

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration d'environnement invalide:\n${issues}`);
  }

  return result.data;
}

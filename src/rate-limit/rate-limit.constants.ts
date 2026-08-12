/**
 * Limitation de débit — constantes de référence.
 *
 * Toutes les valeurs ci-dessous sont les **défauts** ; chacune est ajustable
 * par la variable d'environnement indiquée en commentaire (validée dans
 * `src/config/env.schema.ts`). Les changer ne demande donc aucun déploiement
 * de code.
 */

/** Durée d'une fenêtre « minute », en millisecondes. */
export const MINUTE_WINDOW_MS = 60_000;

/** Durée d'une fenêtre « heure », en millisecondes. */
export const HOUR_WINDOW_MS = 3_600_000;

/**
 * Noms des compteurs (« throttlers » au sens de `@nestjs/throttler`).
 *
 * Deux familles :
 * - `MINUTE` / `HOUR` comptent sur l'identifiant **principal** de la requête
 *   (utilisateur, clé API, ou IP selon la route) ;
 * - `MINUTE_ALT` / `HOUR_ALT` comptent sur un identifiant **secondaire**, et
 *   ne servent aujourd'hui qu'aux routes non authentifiées, où l'on compte
 *   aussi par identifiant visé (l'email). Les deux compteurs s'appliquent
 *   simultanément : c'est le plus restrictif qui déclenche le 429.
 */
export const RATE_LIMIT_WINDOW = {
  MINUTE: 'minute',
  HOUR: 'hour',
  MINUTE_ALT: 'minute-alt',
  HOUR_ALT: 'hour-alt',
} as const;

/**
 * Politiques de limitation. Une route porte exactement **une** politique
 * (via `@RateLimit(...)`), qui remplace entièrement la politique par défaut —
 * il n'y a pas d'empilement de budgets.
 */
export const RATE_LIMIT_POLICY = {
  /** Toute route qui ne déclare rien : budget global par identité. */
  DEFAULT: 'default',
  /** `POST /v1/auth/login` */
  LOGIN: 'login',
  /** `POST /v1/auth/register` */
  REGISTER: 'register',
  /** `POST /v1/auth/change-password` */
  CHANGE_PASSWORD: 'change-password',
  /** `POST /v1/auth/resend-confirmation` */
  RESEND_CONFIRMATION: 'resend-confirmation',
  /** `POST /v1/emails` */
  EMAIL_SEND: 'email-send',
  /** `POST /v1/domains/:id/check` */
  DOMAIN_CHECK: 'domain-check',
  /** `GET /v1/domains/:id/dns-check` */
  DNS_CHECK: 'dns-check',
  /** `POST /v1/webhooks/sns` */
  SNS_WEBHOOK: 'sns-webhook',
  /** `GET /health` — jamais compté (voir plus bas). */
  EXEMPT: 'exempt',
} as const;

/**
 * Nature de l'identifiant sur lequel on compte.
 *
 * Le choix n'est pas cosmétique : en Guinée, les abonnés mobiles Orange/MTN
 * partagent massivement les mêmes IP publiques (NAT opérateur). Compter par
 * IP sur une route authentifiée reviendrait à punir des dizaines de clients
 * légitimes pour l'excès d'un seul. Les routes authentifiées comptent donc
 * par identité (utilisateur ou clé API), jamais par IP.
 */
export const TRACKER_KIND = {
  /** Clé API si présente, sinon utilisateur, sinon IP (politique par défaut). */
  IDENTITY: 'identity',
  /** Utilisateur de session ; repli sur l'IP si la requête n'est pas authentifiée. */
  USER: 'user',
  /** Clé API ; repli sur l'IP si aucune clé n'est présentée. */
  API_KEY: 'api-key',
  /** IP réelle du client (résolue via `X-Forwarded-For`, voir `TRUST_PROXY_HOPS`). */
  IP: 'ip',
  /** IP **et** email visé, comptés séparément : le plus restrictif gagne. */
  IP_AND_EMAIL: 'ip-and-email',
} as const;

/** Limites par défaut, en nombre de requêtes par fenêtre. */
export const RATE_LIMIT_DEFAULTS = {
  /** `RATE_LIMIT_DEFAULT_PER_MINUTE` — budget global de toute route non déclarée. */
  DEFAULT_PER_MINUTE: 120,
  /** `RATE_LIMIT_LOGIN_PER_MINUTE` — anti-bourrinage court sur la connexion. */
  LOGIN_PER_MINUTE: 5,
  /** `RATE_LIMIT_LOGIN_PER_HOUR` — anti-bourrinage lent, cumulé au précédent. */
  LOGIN_PER_HOUR: 20,
  /** `RATE_LIMIT_REGISTER_PER_HOUR` — création de comptes en masse. */
  REGISTER_PER_HOUR: 3,
  /** `RATE_LIMIT_CHANGE_PASSWORD_PER_HOUR` — par utilisateur, pas par IP. */
  CHANGE_PASSWORD_PER_HOUR: 5,
  /**
   * `RATE_LIMIT_RESEND_CONFIRMATION_PER_HOUR` — renvoi du lien de
   * confirmation, compté **par utilisateur**.
   *
   * Ce n'est pas un confort d'ergonomie mais une protection tierce. Rien
   * n'empêche quelqu'un d'inscrire un compte avec l'adresse d'**une autre
   * personne** (l'inscription ne vérifie rien, c'est précisément ce qu'on est
   * en train de corriger), de s'y connecter puisqu'il en a choisi le mot de
   * passe, puis de marteler ce renvoi : la victime reçoit alors autant
   * d'emails que l'attaquant le veut, expédiés par notre compte SES et donc
   * imputés à notre réputation.
   *
   * 3 par heure : de quoi couvrir un vrai besoin (email non reçu, mis en
   * indésirables, adresse ajoutée aux contacts puis nouvel essai) sans
   * transformer la route en robinet. L'unicité de `User.email` empêche de
   * multiplier les comptes sur la même victime, et `REGISTER_PER_HOUR` (3/IP)
   * borne déjà la création de comptes : les trois limites se composent.
   */
  RESEND_CONFIRMATION_PER_HOUR: 3,
  /**
   * `RATE_LIMIT_EMAILS_PER_MINUTE` — protection de rafale uniquement. Le
   * quota journalier et les crédits restent les limites métier réelles.
   */
  EMAILS_PER_MINUTE: 60,
  /** `RATE_LIMIT_DOMAIN_CHECK_PER_HOUR` — chaque appel tape l'API AWS. */
  DOMAIN_CHECK_PER_HOUR: 10,
  /**
   * `RATE_LIMIT_DNS_CHECK_PER_HOUR` — chaque appel fait plusieurs
   * résolutions DNS réseau (3 CNAME DKIM + TXT SPF + TXT DMARC). Ne coûte
   * rien côté AWS (contrairement à `DOMAIN_CHECK`) ; le budget est donc plus
   * large pour laisser le client re-tester après chaque correction pendant
   * qu'il corrige sa zone DNS.
   */
  DNS_CHECK_PER_HOUR: 30,
  /**
   * `RATE_LIMIT_SNS_PER_MINUTE` — SNS livre par rafales et retente ; la vraie
   * barrière est la signature. Volontairement large : bloquer AWS trop tôt
   * ferait perdre des bounces/plaintes.
   */
  SNS_PER_MINUTE: 300,
} as const;

/** Nombre de proxys de confiance par défaut (Dokploy/Traefik en pose un). */
export const DEFAULT_TRUST_PROXY_HOPS = 1;

/**
 * Message unique renvoyé pour **tout** dépassement, y compris sur les routes
 * d'authentification : il ne dit ni quel compteur a sauté, ni si l'email visé
 * correspond à un compte existant. Aucune énumération possible.
 */
export const TOO_MANY_REQUESTS_MESSAGE =
  'Trop de requêtes. Réessayez dans quelques instants.';

/** Préfixe de toutes les clés Redis de compteurs. */
export const RATE_LIMIT_KEY_PREFIX = 'throttle:';

/** Suffixe des clés Redis marquant un compteur en état bloqué. */
export const RATE_LIMIT_BLOCK_KEY_SUFFIX = ':blocked';

/** Token d'injection du client Redis dédié aux compteurs. */
export const RATE_LIMIT_REDIS = 'RATE_LIMIT_REDIS';

/** Valeur repli quand aucune IP n'est déterminable (socket déjà fermé, tests). */
export const UNKNOWN_IP = 'unknown';

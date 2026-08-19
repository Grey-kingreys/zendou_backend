import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { SMTPServerSession } from 'smtp-server';
import {
  MINUTE_WINDOW_MS,
  RATE_LIMIT_DEFAULTS,
  UNKNOWN_IP,
} from '../rate-limit/rate-limit.constants';
import {
  SMTP_DEFAULT_AUTH_FAILURE_WINDOW_MS,
  SMTP_DEFAULT_AUTH_STUFFING_USERNAME_THRESHOLD,
  SMTP_DEFAULT_CONNECTION_WINDOW_MS,
  SMTP_DEFAULT_MAX_AUTH_FAILURES_PER_CONNECTION,
  SMTP_DEFAULT_MAX_CONNECTIONS_PER_IP,
  SMTP_DEFAULT_MAX_MESSAGES_PER_CONNECTION,
  SMTP_DEFAULT_MAX_REFUSED_RECIPIENTS_PER_CONNECTION,
} from './smtp-relay.constants';
import { SMTP_REPLY_TOO_MANY_CONNECTIONS } from './smtp-reply';
import { smtpReplyToError } from './smtp-reply.adapter';
import {
  SMTP_REPLY_SEND_RATE_EXCEEDED,
  SMTP_REPLY_TOO_MANY_AUTH_FAILURES,
  SMTP_REPLY_TOO_MANY_MESSAGES,
  SMTP_REPLY_TOO_MANY_REFUSED_RECIPIENTS,
  SMTP_THROTTLE_KEY_PREFIX,
  SMTP_THROTTLE_REDIS,
} from './smtp-throttle.constants';

/** Nom du script Lua « incrémenter dans une fenêtre » enregistré sur ioredis. */
const HIT_COMMAND = 'zendouSmtpHit';

/** Nom du script Lua « compter des valeurs distinctes dans une fenêtre ». */
const DISTINCT_COMMAND = 'zendouSmtpDistinct';

/**
 * Compteur à fenêtre : `INCR` puis `PEXPIRE` si la clé vient de naître (§5 —
 * « la même mécanique que `RedisThrottlerStorage` »). Le tout en une exécution
 * atomique : en deux allers-retours, deux connexions simultanées pourraient
 * incrémenter avant que l'une des deux ne pose la fenêtre, et la clé
 * survivrait alors sans expiration.
 *
 * Rend `[coups, ttlRestantMs]`.
 */
const HIT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local expire = redis.call('PTTL', KEYS[1])
if expire < 0 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
  expire = tonumber(ARGV[1])
end
return { hits, expire }
`;

/**
 * Ensemble à fenêtre : `SADD` puis `SCARD`, la fenêtre étant posée à la
 * création. Sert uniquement à la détection de bourrinage d'identifiants —
 * combien de noms d'utilisateur **différents** une même IP a-t-elle ratés.
 *
 * Rend `[cardinalité]`.
 */
const DISTINCT_SCRIPT = `
redis.call('SADD', KEYS[1], ARGV[1])
local expire = redis.call('PTTL', KEYS[1])
if expire < 0 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return { redis.call('SCARD', KEYS[1]) }
`;

/** Client ioredis augmenté des deux scripts via `defineCommand`. */
type ThrottleCapableRedis = Pick<Redis, 'defineCommand' | 'disconnect'> & {
  [HIT_COMMAND]: (key: string, windowMs: string) => Promise<[number, number]>;
  [DISTINCT_COMMAND]: (
    key: string,
    member: string,
    windowMs: string,
  ) => Promise<[number]>;
};

/**
 * Compteurs portés par **une** connexion, en mémoire du processus.
 *
 * Ils n'ont rien à faire dans Redis : une connexion ne survit pas au processus
 * qui la tient, et deux répliques ne partagent jamais un socket. Y mettre ces
 * trois entiers coûterait un aller-retour réseau par commande SMTP pour une
 * donnée dont personne d'autre n'a l'usage. Ce qui doit être partagé — ce qui
 * traverse les connexions et les répliques — est dans Redis : IP, nom
 * d'utilisateur, utilisateur.
 */
interface SmtpConnectionCounters {
  /** Échecs d'AUTH constatés sur cette connexion. */
  authFailures: number;
  /** Messages acceptés sur cette connexion. */
  messages: number;
  /** Destinataires refusés sur cette connexion (anti-moissonnage). */
  refusedRecipients: number;
}

/**
 * Anti-abus du relais SMTP (B6/S9 — §5 du plan).
 *
 * ## Ce que ce service protège, et pourquoi pas par IP pour l'envoi
 *
 * Trois familles de compteurs, sur trois identités différentes :
 *
 * | Famille | Identité | Portée |
 * |---|---|---|
 * | Connexions, échecs d'AUTH | **IP** | Redis, partagée entre répliques |
 * | Rafale d'envoi | **utilisateur** | Redis, partagée |
 * | Messages, `RCPT` refusés, échecs d'AUTH | **connexion** | mémoire |
 *
 * Le choix de l'identité est la décision de conception qui compte. L'envoi
 * n'est **jamais** compté par IP : en Guinée, les abonnés mobiles Orange/MTN
 * partagent massivement les mêmes IP publiques (NAT opérateur) — le
 * raisonnement est déjà écrit dans `rate-limit.constants.ts` et s'applique mot
 * pour mot ici. Compter l'envoi par IP punirait des dizaines de clients
 * légitimes pour l'excès d'un seul. À l'inverse, les connexions et les échecs
 * d'authentification **doivent** se compter par IP : il n'y a pas encore
 * d'identité à ce stade de la conversation, et c'est précisément ce que
 * l'attaquant essaie d'obtenir.
 *
 * ## Le préfixe de clés
 *
 * Toutes les clés commencent par {@link SMTP_THROTTLE_KEY_PREFIX} (`smtp:`),
 * jamais par celui du limiteur HTTP (`throttle:`) : même Redis, budgets
 * séparés.
 *
 * ## En cas de panne Redis : on laisse passer
 *
 * Un compteur indisponible journalise une erreur et **n'applique pas** sa
 * limite, exactement comme le magasin du limiteur HTTP
 * (`rate-limit-core.module.ts` : « un compteur ne doit jamais faire tomber
 * l'API »). Refuser tout le trafic SMTP parce qu'un compteur est muet
 * transformerait une panne d'infrastructure secondaire en interruption de
 * service ; les vraies barrières métier — crédits, quota, domaine vérifié —
 * sont dans la base et restent debout.
 *
 * ## Ce qui est câblé ici, et ce qui attend S7
 *
 * S5 ne connaît que `onConnect` et `onAuth` : ces deux chemins sont branchés.
 * `MAIL FROM`, `RCPT TO` et la fin de `DATA` n'existent pas encore — les
 * méthodes qui les concernent sont livrées, testées et documentées ; **c'est
 * S7 qui les appelle**. Chacune porte l'étiquette `[S7 — …]` dans sa
 * documentation, et toutes suivent la même convention que S5 : elles **lèvent**
 * une erreur de {@link smtpReplyToError}, que l'enveloppe anti-exception de
 * `SmtpServerService` transmet telle quelle au client.
 */
@Injectable()
export class SmtpThrottleService implements OnModuleDestroy {
  private readonly logger = new Logger(SmtpThrottleService.name);
  private readonly connections = new Map<string, SmtpConnectionCounters>();
  private readonly client: ThrottleCapableRedis;

  constructor(
    @Inject(SMTP_THROTTLE_REDIS) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {
    this.redis.defineCommand(HIT_COMMAND, {
      numberOfKeys: 1,
      lua: HIT_SCRIPT,
    });
    this.redis.defineCommand(DISTINCT_COMMAND, {
      numberOfKeys: 1,
      lua: DISTINCT_SCRIPT,
    });

    this.client = this.redis as unknown as ThrottleCapableRedis;
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  /**
   * Les limites **par IP** sont-elles appliquées ?
   *
   * Faux quand `SMTP_IP_LIMITS_ENABLED=false` : aucune clé par IP n'est alors
   * écrite et aucune connexion n'est refusée sur ce motif. C'est la réponse au
   * piège du §1.3 — sous Docker Swarm en mode `ingress`, le *routing mesh*
   * réécrit l'IP source et toutes les connexions arrivent avec celle de la
   * passerelle. Une limite par IP deviendrait un compteur unique partagé par
   * tout Internet : le premier client à saturer ferait taire tous les autres.
   * « Une limite qui compte tout le monde ensemble est pire qu'une limite
   * absente » (§5) — on la coupe donc franchement, avec un avertissement au
   * démarrage, plutôt que de la laisser à faux.
   *
   * Les limites **par utilisateur** et **par connexion**, elles, ne dépendent
   * pas de l'IP et restent actives en toutes circonstances.
   *
   * Le test est `!== false` et non `=== true` : une valeur absente vaut le
   * défaut du schéma d'environnement, qui est `true`. Il faut dire non
   * explicitement pour désarmer une protection.
   */
  get ipLimitsEnabled(): boolean {
    return this.configService.get<boolean>('SMTP_IP_LIMITS_ENABLED') !== false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Connexion — câblé par S5 (`onConnect` / `onClose`)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Ouvre les compteurs de la connexion et applique le plafond par IP.
   *
   * Lève {@link SMTP_REPLY_TOO_MANY_CONNECTIONS} (`421 4.7.0`) au-delà de
   * `SMTP_MAX_CONNECTIONS_PER_IP` connexions depuis la même IP pendant
   * `SMTP_CONNECTION_WINDOW_MS`. `smtp-server` ferme le socket de lui-même sur
   * un `421`, et le client lit ce refus **à la place de la bannière `220`** :
   * la conversation n'a jamais lieu.
   */
  async registerConnection(session: SMTPServerSession): Promise<void> {
    this.connections.set(session.id, {
      authFailures: 0,
      messages: 0,
      refusedRecipients: 0,
    });

    if (!this.ipLimitsEnabled) {
      return;
    }

    const ip = remoteAddress(session);
    const windowMs = this.setting(
      'SMTP_CONNECTION_WINDOW_MS',
      SMTP_DEFAULT_CONNECTION_WINDOW_MS,
    );
    const limit = this.setting(
      'SMTP_MAX_CONNECTIONS_PER_IP',
      SMTP_DEFAULT_MAX_CONNECTIONS_PER_IP,
    );

    const hits = await this.hit(
      `${SMTP_THROTTLE_KEY_PREFIX}conn:ip:${ip}`,
      windowMs,
    );

    if (hits > limit) {
      this.logger.warn(
        `Connexion SMTP refusée depuis ${ip} : ${hits} connexions en ${windowMs} ms (plafond ${limit})`,
      );
      throw smtpReplyToError(SMTP_REPLY_TOO_MANY_CONNECTIONS);
    }
  }

  /**
   * Referme les compteurs de la connexion. Appelée depuis `onClose`, y compris
   * pour une connexion refusée à l'ouverture : sans cela, la table des
   * compteurs grandirait indéfiniment — une fuite de mémoire pilotée par
   * l'attaquant, ce qui serait un comble pour un module anti-abus.
   */
  releaseConnection(session: SMTPServerSession): void {
    this.connections.delete(session.id);
  }

  /** Lecture seule des compteurs d'une connexion (journalisation, tests). */
  connectionCounters(
    session: SMTPServerSession,
  ): Readonly<SmtpConnectionCounters> {
    return this.countersFor(session);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Authentification — câblé par S5 (`onAuth`)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Compte un échec d'authentification et coupe le bourrinage.
   *
   * Écrit trois compteurs Redis — `smtp:auth:fail:ip:<ip>`,
   * `smtp:auth:fail:user:<username>` et l'ensemble `smtp:auth:stuffing:<ip>`
   * qui recense les noms d'utilisateur distincts ratés par cette IP — puis
   * lève {@link SMTP_REPLY_TOO_MANY_AUTH_FAILURES} (`421` + fermeture) dès que
   * la connexion dépasse `SMTP_MAX_AUTH_FAILURES_PER_CONNECTION` échecs.
   *
   * **Aucun verrouillage de compte** (§5). Bloquer un identifiant sur ses
   * échecs offrirait un déni de service à quiconque en connaît le nom : il
   * suffirait de présenter de mauvais mots de passe pour couper l'envoi d'un
   * client. Le compteur par nom d'utilisateur existe pour **voir**, pas pour
   * bloquer ; ce qui bloque est la connexion et l'IP.
   *
   * **Aucun secret ici.** La signature ne reçoit pas le mot de passe présenté,
   * et ne peut donc pas le journaliser : c'est la garantie du §5 rendue
   * structurelle plutôt que confiée à la vigilance de l'appelant.
   *
   * @param username Nom d'utilisateur présenté, ou `undefined` s'il manquait.
   *   Sans lui, seuls les compteurs par IP sont écrits — compter une clé
   *   `…:user:undefined` mélangerait des tentatives sans rapport.
   */
  async recordAuthFailure(
    session: SMTPServerSession,
    username: string | undefined,
  ): Promise<void> {
    const counters = this.countersFor(session);
    counters.authFailures += 1;

    const ip = remoteAddress(session);
    const windowMs = this.setting(
      'SMTP_AUTH_FAILURE_WINDOW_MS',
      SMTP_DEFAULT_AUTH_FAILURE_WINDOW_MS,
    );

    if (this.ipLimitsEnabled) {
      await this.hit(`${SMTP_THROTTLE_KEY_PREFIX}auth:fail:ip:${ip}`, windowMs);
      await this.detectCredentialStuffing(ip, username, windowMs);
    }

    if (username) {
      await this.hit(
        `${SMTP_THROTTLE_KEY_PREFIX}auth:fail:user:${username}`,
        windowMs,
      );
    }

    const tolerated = this.setting(
      'SMTP_MAX_AUTH_FAILURES_PER_CONNECTION',
      SMTP_DEFAULT_MAX_AUTH_FAILURES_PER_CONNECTION,
    );

    if (counters.authFailures > tolerated) {
      this.logger.warn(
        `Connexion SMTP ${session.id} fermée : ${counters.authFailures} échecs d’authentification depuis ${ip} (plafond ${tolerated})`,
      );
      throw smtpReplyToError(SMTP_REPLY_TOO_MANY_AUTH_FAILURES);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // API destinée à S7 — livrée et testée ici, appelée là-bas
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * **[S7 — `MAIL FROM`]** Applique la protection de rafale d'envoi, comptée
   * **par utilisateur** sur `smtp:send:user:<userId>`, fenêtre d'une minute.
   *
   * Équivalent SMTP de `RATE_LIMIT_EMAILS_PER_MINUTE` : même défaut (60/min,
   * lu dans la même constante), budget séparé — un client qui utilise les deux
   * canaux n'y perd rien. Lève {@link SMTP_REPLY_SEND_RATE_EXCEEDED}
   * (`451 4.7.0`, temporaire) au-delà.
   *
   * À appeler avec l'identifiant de l'utilisateur porté par la session
   * (`smtpSessionUser(session).user.id`), **jamais** avec une IP.
   */
  async assertSendBurstWithinLimit(userId: string): Promise<void> {
    const limit = this.setting(
      'SMTP_EMAILS_PER_MINUTE',
      RATE_LIMIT_DEFAULTS.EMAILS_PER_MINUTE,
    );

    const hits = await this.hit(
      `${SMTP_THROTTLE_KEY_PREFIX}send:user:${userId}`,
      MINUTE_WINDOW_MS,
    );

    if (hits > limit) {
      this.logger.warn(
        `Rafale d’envoi SMTP refusée pour l’utilisateur ${userId} : ${hits} messages dans la minute (plafond ${limit})`,
      );
      throw smtpReplyToError(SMTP_REPLY_SEND_RATE_EXCEEDED);
    }
  }

  /**
   * **[S7 — `MAIL FROM`]** Vérifie que la connexion n'a pas épuisé son quota de
   * messages (`SMTP_MAX_MESSAGES_PER_CONNECTION`, défaut 100).
   *
   * Lève {@link SMTP_REPLY_TOO_MANY_MESSAGES} (`421` + fermeture) : le client
   * n'a qu'à rouvrir une connexion. À appeler **avant** d'accepter le message,
   * là où le §4.8 place les contrôles anticipés.
   */
  assertMessageCountWithinLimit(session: SMTPServerSession): void {
    const counters = this.countersFor(session);
    const limit = this.setting(
      'SMTP_MAX_MESSAGES_PER_CONNECTION',
      SMTP_DEFAULT_MAX_MESSAGES_PER_CONNECTION,
    );

    if (counters.messages >= limit) {
      this.logger.warn(
        `Connexion SMTP ${session.id} fermée : ${counters.messages} messages sur une seule connexion (plafond ${limit})`,
      );
      throw smtpReplyToError(SMTP_REPLY_TOO_MANY_MESSAGES);
    }
  }

  /**
   * **[S7 — fin de `DATA`]** Compte un message accepté sur la connexion.
   *
   * À appeler une seule fois par message, quel que soit le nombre de
   * destinataires : c'est un plafond de conversation, pas de facturation (les
   * crédits, eux, se débitent par destinataire dans `accept()`).
   */
  recordMessage(session: SMTPServerSession): void {
    this.countersFor(session).messages += 1;
  }

  /**
   * **[S7 — `RCPT TO` refusé]** Compte un destinataire refusé et coupe le
   * moissonnage d'adresses.
   *
   * À appeler **après** avoir décidé de refuser un destinataire, quel qu'en
   * soit le motif. Tant que le plafond n'est pas dépassé, cette méthode ne
   * lève rien et S7 rend son refus habituel ; au-delà, elle lève
   * {@link SMTP_REPLY_TOO_MANY_REFUSED_RECIPIENTS} (`421` + fermeture), qui
   * **remplace** ce refus — la connexion s'arrête là.
   */
  recordRefusedRecipient(session: SMTPServerSession): void {
    const counters = this.countersFor(session);
    counters.refusedRecipients += 1;

    const tolerated = this.setting(
      'SMTP_MAX_REFUSED_RECIPIENTS_PER_CONNECTION',
      SMTP_DEFAULT_MAX_REFUSED_RECIPIENTS_PER_CONNECTION,
    );

    if (counters.refusedRecipients > tolerated) {
      this.logger.warn(
        `Connexion SMTP ${session.id} fermée depuis ${remoteAddress(session)} : ${counters.refusedRecipients} destinataires refusés (plafond ${tolerated}) — moissonnage d’adresses probable`,
      );
      throw smtpReplyToError(SMTP_REPLY_TOO_MANY_REFUSED_RECIPIENTS);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Interne
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Alerte du §5 : « une ligne de log quand **une IP échoue sur plusieurs noms
   * d'utilisateur différents** — c'est la signature du stuffing ».
   *
   * Se tromper de mot de passe sur son propre identifiant est banal ; se
   * tromper sur trois identifiants distincts depuis la même IP en quinze
   * minutes n'a aucune explication légitime. L'alerte n'entraîne **aucun
   * blocage** : elle nomme l'IP pour que l'exploitation décide, au pare-feu, ce
   * qu'elle veut en faire.
   */
  private async detectCredentialStuffing(
    ip: string,
    username: string | undefined,
    windowMs: number,
  ): Promise<void> {
    if (!username) {
      return;
    }

    const distinct = await this.countDistinct(
      `${SMTP_THROTTLE_KEY_PREFIX}auth:stuffing:${ip}`,
      username,
      windowMs,
    );

    const threshold = this.setting(
      'SMTP_AUTH_STUFFING_USERNAME_THRESHOLD',
      SMTP_DEFAULT_AUTH_STUFFING_USERNAME_THRESHOLD,
    );

    if (distinct >= threshold) {
      this.logger.warn(
        `Alerte bourrinage d’identifiants SMTP : l’adresse ${ip} a échoué sur ${distinct} noms d’utilisateur différents en ${windowMs} ms`,
      );
    }
  }

  private countersFor(session: SMTPServerSession): SmtpConnectionCounters {
    const existing = this.connections.get(session.id);

    if (existing) {
      return existing;
    }

    // Filet : une session que `onConnect` n'a pas enregistrée (test isolé,
    // ordre d'appel inattendu) obtient des compteurs neufs plutôt qu'une
    // exception. Perdre un compteur vaut mieux que casser une conversation.
    const created: SmtpConnectionCounters = {
      authFailures: 0,
      messages: 0,
      refusedRecipients: 0,
    };
    this.connections.set(session.id, created);

    return created;
  }

  /**
   * Lit un réglage entier positif, avec repli sur le défaut du plan.
   *
   * `env.schema.ts` garantit déjà la forme de ces variables ; ce repli couvre
   * l'autre appelant possible — un contexte de test qui ne fournit qu'une
   * partie de la configuration. Sans lui, un réglage absent donnerait `NaN`,
   * donc une comparaison toujours fausse, donc une protection silencieusement
   * désactivée : exactement ce que le §5 interdit.
   */
  private setting(key: string, fallback: number): number {
    const value = this.configService.get<number>(key);

    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : fallback;
  }

  /** Incrémente un compteur de fenêtre. Rend `0` si Redis est muet (voir la doc de classe). */
  private async hit(key: string, windowMs: number): Promise<number> {
    try {
      const [hits] = await this.client[HIT_COMMAND](key, String(windowMs));

      return hits;
    } catch (error: unknown) {
      this.unavailable(key, error);

      return 0;
    }
  }

  /** Ajoute une valeur à un ensemble de fenêtre et rend sa cardinalité. */
  private async countDistinct(
    key: string,
    member: string,
    windowMs: number,
  ): Promise<number> {
    try {
      const [distinct] = await this.client[DISTINCT_COMMAND](
        key,
        member,
        String(windowMs),
      );

      return distinct;
    } catch (error: unknown) {
      this.unavailable(key, error);

      return 0;
    }
  }

  private unavailable(key: string, error: unknown): void {
    this.logger.error(
      `Compteur anti-abus SMTP indisponible (clé « ${key} ») — limite non appliquée : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * IP de la connexion, avec le même repli que le limiteur HTTP quand elle n'est
 * pas déterminable (socket déjà fermé, contexte de test). Constante partagée
 * plutôt que littéral : les deux canaux nomment cette situation pareil.
 */
function remoteAddress(session: SMTPServerSession): string {
  return session.remoteAddress || UNKNOWN_IP;
}

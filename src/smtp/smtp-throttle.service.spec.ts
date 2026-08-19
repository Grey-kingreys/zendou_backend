import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { SMTPServerSession } from 'smtp-server';
import { RATE_LIMIT_KEY_PREFIX } from '../rate-limit/rate-limit.constants';
import { RedisThrottlerStorage } from '../rate-limit/redis-throttler.storage';
import { FakeThrottleRedis } from './fixtures/fake-throttle-redis';
import { SMTP_REPLY_TOO_MANY_CONNECTIONS } from './smtp-reply';
import { isSmtpReplyError } from './smtp-reply.adapter';
import {
  SMTP_REPLY_SEND_RATE_EXCEEDED,
  SMTP_REPLY_TOO_MANY_AUTH_FAILURES,
  SMTP_REPLY_TOO_MANY_MESSAGES,
  SMTP_REPLY_TOO_MANY_REFUSED_RECIPIENTS,
} from './smtp-throttle.constants';
import { SmtpThrottleService } from './smtp-throttle.service';

/**
 * Anti-abus SMTP — compteurs, plafonds et clés Redis (B6/S9).
 *
 * Redis est **mocké** (`FakeThrottleRedis`, qui compte réellement) et les clés
 * sont assertées **littéralement**, jamais recomposées depuis les constantes du
 * code testé : une spec qui écrirait `` `${PREFIX}conn:ip:${ip}` `` passerait
 * encore si le préfixe devenait `throttle:` et écrasait les compteurs HTTP.
 * C'est précisément ce que le §5 interdit, donc c'est ce que ces tests doivent
 * pouvoir attraper.
 */

const IP = '41.223.10.5';

/** Session `smtp-server` réduite à ce que le service en lit. */
function sessionAt(id: string, remoteAddress = IP): SMTPServerSession {
  return { id, remoteAddress } as unknown as SMTPServerSession;
}

function buildService(config: Record<string, unknown> = {}): {
  service: SmtpThrottleService;
  redis: FakeThrottleRedis;
} {
  const redis = new FakeThrottleRedis();
  const configService = {
    get: (key: string) => config[key],
  } as unknown as ConfigService;

  return {
    service: new SmtpThrottleService(redis.asRedis(), configService),
    redis,
  };
}

/**
 * Exécute et rend la réponse SMTP levée, ou `null` si rien n'a été refusé.
 *
 * Comparer une `SmtpReply` plutôt qu'un message d'erreur : c'est l'identité de
 * la constante qui fait foi, pas le texte, qu'un jour on reformulera.
 */
async function refusalOf(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error: unknown) {
    if (isSmtpReplyError(error)) {
      return error.smtpReply;
    }
    throw error;
  }
}

describe('SmtpThrottleService — scripts Redis', () => {
  it('enregistre les deux scripts Lua, sur une clé chacun', () => {
    const { redis } = buildService();

    expect([...redis.definedCommands.keys()]).toEqual([
      'zendouSmtpHit',
      'zendouSmtpDistinct',
    ]);
    expect(redis.definedCommands.get('zendouSmtpHit')).toMatchObject({
      numberOfKeys: 1,
    });
    expect(redis.definedCommands.get('zendouSmtpDistinct')).toMatchObject({
      numberOfKeys: 1,
    });
  });

  it('ferme la connexion Redis à l’arrêt du module', () => {
    const { service, redis } = buildService();

    service.onModuleDestroy();

    expect(redis.disconnected).toBe(true);
  });
});

describe('SmtpThrottleService — clés Redis, assertées littéralement', () => {
  it('compte les connexions sur smtp:conn:ip:<ip>', async () => {
    const { service, redis } = buildService({
      SMTP_CONNECTION_WINDOW_MS: 60_000,
    });

    await service.registerConnection(sessionAt('session-1'));

    expect(redis.hitCalls).toEqual([
      { key: 'smtp:conn:ip:41.223.10.5', windowMs: '60000' },
    ]);
  });

  it('compte les échecs d’AUTH par IP, par nom d’utilisateur, et l’ensemble des noms ratés', async () => {
    const { service, redis } = buildService({
      SMTP_AUTH_FAILURE_WINDOW_MS: 900_000,
    });

    await service.recordAuthFailure(sessionAt('session-1'), 'zdu_1a2b3c4d');

    expect(redis.hitCalls).toEqual([
      { key: 'smtp:auth:fail:ip:41.223.10.5', windowMs: '900000' },
      { key: 'smtp:auth:fail:user:zdu_1a2b3c4d', windowMs: '900000' },
    ]);
    expect(redis.distinctCalls).toEqual([
      {
        key: 'smtp:auth:stuffing:41.223.10.5',
        member: 'zdu_1a2b3c4d',
        windowMs: '900000',
      },
    ]);
  });

  it('n’écrit aucune clé par nom d’utilisateur quand le client n’en a présenté aucun', async () => {
    const { service, redis } = buildService();

    await service.recordAuthFailure(sessionAt('session-1'), undefined);

    // Une clé `…:user:undefined` agrégerait des tentatives sans rapport, et
    // l'ensemble anti-stuffing compterait un « nom » qui n'existe pas.
    expect(redis.writtenKeys).toEqual(['smtp:auth:fail:ip:41.223.10.5']);
  });

  it('compte la rafale d’envoi par utilisateur, sur une fenêtre d’une minute', async () => {
    const { service, redis } = buildService();

    await service.assertSendBurstWithinLimit('usr_c1x2y3');

    expect(redis.hitCalls).toEqual([
      { key: 'smtp:send:user:usr_c1x2y3', windowMs: '60000' },
    ]);
  });

  it('retombe sur « unknown » quand l’IP n’est pas déterminable', async () => {
    const { service, redis } = buildService();

    await service.registerConnection(sessionAt('session-1', ''));

    expect(redis.hitCalls[0].key).toBe('smtp:conn:ip:unknown');
  });

  /**
   * La preuve que les deux familles de compteurs ne se marchent pas dessus est
   * faite contre les **vraies** clés du limiteur HTTP, produites par
   * `RedisThrottlerStorage` lui-même : comparer à un littéral `'throttle:'`
   * recopié ici ne prouverait rien le jour où ce préfixe changerait.
   */
  it('n’écrit jamais une clé du limiteur HTTP, et réciproquement', async () => {
    const { service, redis } = buildService();

    await service.registerConnection(sessionAt('session-1'));
    await service.recordAuthFailure(sessionAt('session-1'), 'zdu_1a2b3c4d');
    await service.assertSendBurstWithinLimit('usr_c1x2y3');

    const httpKeys: string[] = [];
    const httpRedis = {
      defineCommand: () => undefined,
      disconnect: () => undefined,
      zendouThrottle: (hitsKey: string, blockKey: string) => {
        httpKeys.push(hitsKey, blockKey);
        return Promise.resolve([1, 60_000, 0, 0] as [
          number,
          number,
          number,
          number,
        ]);
      },
    };
    const storage = new RedisThrottlerStorage(httpRedis as unknown as Redis);
    // Identité volontairement identique à l'une des nôtres : si les préfixes
    // étaient partagés, un envoi SMTP consommerait le budget HTTP du même
    // utilisateur, et cette collision-là serait invisible sans ce test.
    await storage.increment('usr_c1x2y3', 60_000, 60, 60_000);

    expect(redis.writtenKeys).not.toHaveLength(0);
    expect(httpKeys).not.toHaveLength(0);
    expect(httpKeys.every((key) => key.startsWith(RATE_LIMIT_KEY_PREFIX))).toBe(
      true,
    );

    for (const key of redis.writtenKeys) {
      expect(key.startsWith(RATE_LIMIT_KEY_PREFIX)).toBe(false);
      expect(key.startsWith('smtp:')).toBe(true);
    }
    for (const key of httpKeys) {
      expect(redis.writtenKeys).not.toContain(key);
    }
  });
});

describe('SmtpThrottleService — plafond de connexions par IP', () => {
  it('accepte jusqu’au plafond puis refuse en 421', async () => {
    const { service } = buildService({ SMTP_MAX_CONNECTIONS_PER_IP: 2 });

    expect(
      await refusalOf(() => service.registerConnection(sessionAt('s1'))),
    ).toBe(null);
    expect(
      await refusalOf(() => service.registerConnection(sessionAt('s2'))),
    ).toBe(null);

    expect(
      await refusalOf(() => service.registerConnection(sessionAt('s3'))),
    ).toBe(SMTP_REPLY_TOO_MANY_CONNECTIONS);
    expect(SMTP_REPLY_TOO_MANY_CONNECTIONS.code).toBe(421);
  });

  it('compte séparément deux IP différentes', async () => {
    const { service } = buildService({ SMTP_MAX_CONNECTIONS_PER_IP: 1 });

    await service.registerConnection(sessionAt('s1', '41.223.10.5'));

    expect(
      await refusalOf(() =>
        service.registerConnection(sessionAt('s2', '41.223.10.6')),
      ),
    ).toBe(null);
  });
});

describe('SmtpThrottleService — échecs d’authentification', () => {
  it('tolère N échecs sur une connexion puis coupe le N+1ᵉ en 421', async () => {
    const { service } = buildService({
      SMTP_MAX_AUTH_FAILURES_PER_CONNECTION: 2,
    });
    const session = sessionAt('session-1');

    expect(
      await refusalOf(() => service.recordAuthFailure(session, 'zdu_aaa')),
    ).toBe(null);
    expect(
      await refusalOf(() => service.recordAuthFailure(session, 'zdu_aaa')),
    ).toBe(null);

    // Le 3ᵉ : le refus 535 de S5 est remplacé par un 421, que `smtp-server`
    // fait suivre de la fermeture du socket.
    expect(
      await refusalOf(() => service.recordAuthFailure(session, 'zdu_aaa')),
    ).toBe(SMTP_REPLY_TOO_MANY_AUTH_FAILURES);
    expect(SMTP_REPLY_TOO_MANY_AUTH_FAILURES.code).toBe(421);
  });

  it('repart de zéro sur une nouvelle connexion — aucun verrouillage de compte', async () => {
    const { service } = buildService({
      SMTP_MAX_AUTH_FAILURES_PER_CONNECTION: 1,
    });

    await refusalOf(() =>
      service.recordAuthFailure(sessionAt('session-1'), 'zdu_aaa'),
    );
    await refusalOf(() =>
      service.recordAuthFailure(sessionAt('session-1'), 'zdu_aaa'),
    );
    service.releaseConnection(sessionAt('session-1'));

    // Même identifiant, même IP, connexion neuve : le §5 refuse le
    // verrouillage de compte, qui offrirait un déni de service à quiconque
    // connaît un nom d'utilisateur.
    expect(
      await refusalOf(() =>
        service.recordAuthFailure(sessionAt('session-2'), 'zdu_aaa'),
      ),
    ).toBe(null);
  });

  it('alerte quand une IP échoue sur plusieurs noms d’utilisateur différents', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { service } = buildService({
      SMTP_AUTH_STUFFING_USERNAME_THRESHOLD: 3,
      SMTP_MAX_AUTH_FAILURES_PER_CONNECTION: 100,
    });

    await service.recordAuthFailure(sessionAt('s1'), 'zdu_aaa');
    await service.recordAuthFailure(sessionAt('s2'), 'zdu_bbb');

    expect(warn.mock.calls.flat().join('\n')).not.toContain('bourrinage');

    await service.recordAuthFailure(sessionAt('s3'), 'zdu_ccc');

    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('bourrinage d’identifiants SMTP');
    expect(logged).toContain(IP);
    expect(logged).toContain('3 noms d’utilisateur différents');

    warn.mockRestore();
  });

  it('n’alerte pas quand la même IP rate le même nom d’utilisateur en boucle', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { service } = buildService({
      SMTP_AUTH_STUFFING_USERNAME_THRESHOLD: 3,
      SMTP_MAX_AUTH_FAILURES_PER_CONNECTION: 100,
    });

    // Un client mal configuré : c'est banal, ce n'est pas du stuffing.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.recordAuthFailure(sessionAt(`s${attempt}`), 'zdu_aaa');
    }

    expect(warn.mock.calls.flat().join('\n')).not.toContain('bourrinage');

    warn.mockRestore();
  });
});

describe('SmtpThrottleService — API livrée à S7', () => {
  it('refuse la rafale d’envoi au-delà du plafond, par utilisateur', async () => {
    const { service } = buildService({ SMTP_EMAILS_PER_MINUTE: 2 });

    expect(
      await refusalOf(() => service.assertSendBurstWithinLimit('usr_1')),
    ).toBe(null);
    expect(
      await refusalOf(() => service.assertSendBurstWithinLimit('usr_1')),
    ).toBe(null);
    expect(
      await refusalOf(() => service.assertSendBurstWithinLimit('usr_1')),
    ).toBe(SMTP_REPLY_SEND_RATE_EXCEEDED);

    // Un autre utilisateur n'est pas affecté : le compteur suit l'identité,
    // jamais l'IP (NAT opérateur guinéen, §5).
    expect(
      await refusalOf(() => service.assertSendBurstWithinLimit('usr_2')),
    ).toBe(null);
    expect(SMTP_REPLY_SEND_RATE_EXCEEDED.code).toBe(451);
  });

  it('plafonne les messages d’une même connexion', async () => {
    const { service } = buildService({ SMTP_MAX_MESSAGES_PER_CONNECTION: 2 });
    const session = sessionAt('session-1');

    for (let sent = 0; sent < 2; sent += 1) {
      expect(
        await refusalOf(() => service.assertMessageCountWithinLimit(session)),
      ).toBe(null);
      service.recordMessage(session);
    }

    expect(
      await refusalOf(() => service.assertMessageCountWithinLimit(session)),
    ).toBe(SMTP_REPLY_TOO_MANY_MESSAGES);
    expect(service.connectionCounters(session).messages).toBe(2);
  });

  it('plafonne les destinataires refusés d’une même connexion', async () => {
    const { service } = buildService({
      SMTP_MAX_REFUSED_RECIPIENTS_PER_CONNECTION: 2,
    });
    const session = sessionAt('session-1');

    expect(await refusalOf(() => service.recordRefusedRecipient(session))).toBe(
      null,
    );
    expect(await refusalOf(() => service.recordRefusedRecipient(session))).toBe(
      null,
    );
    expect(await refusalOf(() => service.recordRefusedRecipient(session))).toBe(
      SMTP_REPLY_TOO_MANY_REFUSED_RECIPIENTS,
    );
  });

  it('libère les compteurs d’une connexion fermée', () => {
    const { service } = buildService({ SMTP_MAX_MESSAGES_PER_CONNECTION: 1 });
    const session = sessionAt('session-1');

    service.recordMessage(session);
    expect(service.connectionCounters(session).messages).toBe(1);

    service.releaseConnection(session);

    // Une session au même identifiant repart neuve : la table ne conserve rien
    // d'une connexion close — sinon l'attaquant piloterait notre mémoire.
    expect(service.connectionCounters(session).messages).toBe(0);
  });
});

describe('SmtpThrottleService — IP source non fiable (§1.3 / §5)', () => {
  const config = {
    SMTP_IP_LIMITS_ENABLED: false,
    SMTP_MAX_CONNECTIONS_PER_IP: 1,
    SMTP_EMAILS_PER_MINUTE: 1,
    SMTP_MAX_AUTH_FAILURES_PER_CONNECTION: 1,
  };

  it('signale que les limites par IP sont désactivées', () => {
    const { service } = buildService(config);

    expect(service.ipLimitsEnabled).toBe(false);
  });

  it('considère les limites par IP actives quand la variable est absente', () => {
    const { service } = buildService({});

    // Défaut du schéma d'environnement : on ne désarme pas une protection par
    // omission, il faut dire non explicitement.
    expect(service.ipLimitsEnabled).toBe(true);
  });

  it('n’écrit aucune clé par IP et ne refuse aucune connexion', async () => {
    const { service, redis } = buildService(config);

    for (const id of ['s1', 's2', 's3']) {
      expect(
        await refusalOf(() => service.registerConnection(sessionAt(id))),
      ).toBe(null);
    }

    expect(redis.writtenKeys).toEqual([]);
  });

  it('n’écrit que la clé par nom d’utilisateur pour un échec d’AUTH', async () => {
    const { service, redis } = buildService(config);

    await refusalOf(() =>
      service.recordAuthFailure(sessionAt('s1'), 'zdu_1a2b3c4d'),
    );

    // Ni compteur par IP, ni ensemble anti-stuffing : les deux seraient
    // agrégés sur l'IP de la passerelle Swarm, donc faux.
    expect(redis.writtenKeys).toEqual(['smtp:auth:fail:user:zdu_1a2b3c4d']);
  });

  it('laisse les limites par connexion intactes', async () => {
    const { service } = buildService(config);
    const session = sessionAt('s1');

    await refusalOf(() => service.recordAuthFailure(session, 'zdu_aaa'));

    // Le plafond par connexion ne dépend pas de l'IP : il reste la barrière
    // qui coupe le bourrinage même quand la source est masquée.
    expect(
      await refusalOf(() => service.recordAuthFailure(session, 'zdu_aaa')),
    ).toBe(SMTP_REPLY_TOO_MANY_AUTH_FAILURES);
  });

  it('laisse la rafale par utilisateur intacte', async () => {
    const { service, redis } = buildService(config);

    expect(
      await refusalOf(() => service.assertSendBurstWithinLimit('usr_1')),
    ).toBe(null);
    expect(
      await refusalOf(() => service.assertSendBurstWithinLimit('usr_1')),
    ).toBe(SMTP_REPLY_SEND_RATE_EXCEEDED);
    expect(redis.writtenKeys).toEqual([
      'smtp:send:user:usr_1',
      'smtp:send:user:usr_1',
    ]);
  });
});

describe('SmtpThrottleService — Redis indisponible', () => {
  it('laisse passer et journalise plutôt que de refuser tout le trafic', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service, redis } = buildService({
      SMTP_MAX_CONNECTIONS_PER_IP: 1,
      SMTP_EMAILS_PER_MINUTE: 1,
    });
    redis.failing = true;

    for (const id of ['s1', 's2', 's3']) {
      expect(
        await refusalOf(() => service.registerConnection(sessionAt(id))),
      ).toBe(null);
    }
    expect(
      await refusalOf(() => service.assertSendBurstWithinLimit('usr_1')),
    ).toBe(null);
    expect(
      await refusalOf(() => service.assertSendBurstWithinLimit('usr_1')),
    ).toBe(null);

    const logged = error.mock.calls.flat().join('\n');
    expect(logged).toContain('Compteur anti-abus SMTP indisponible');
    expect(logged).toContain('smtp:conn:ip:41.223.10.5');

    error.mockRestore();
  });

  it('applique quand même les plafonds par connexion, qui ne dépendent pas de Redis', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { service, redis } = buildService({
      SMTP_MAX_AUTH_FAILURES_PER_CONNECTION: 1,
    });
    redis.failing = true;
    const session = sessionAt('s1');

    await refusalOf(() => service.recordAuthFailure(session, 'zdu_aaa'));

    expect(
      await refusalOf(() => service.recordAuthFailure(session, 'zdu_aaa')),
    ).toBe(SMTP_REPLY_TOO_MANY_AUTH_FAILURES);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

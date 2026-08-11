import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';
import {
  RATE_LIMIT_BLOCK_KEY_SUFFIX,
  RATE_LIMIT_KEY_PREFIX,
  RATE_LIMIT_REDIS,
} from './rate-limit.constants';

/** Nom du script Lua enregistré sur le client ioredis. */
const COMMAND_NAME = 'zendouThrottle';

/**
 * `ThrottlerStorageRecord` n'est pas réexporté par l'index de la
 * bibliothèque : on le dérive du contrat lui-même, ce qui garantit qu'il
 * suivra automatiquement une éventuelle évolution de l'interface.
 */
export type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/**
 * Incrément atomique d'un compteur à fenêtre fixe.
 *
 * Tout tient dans un seul aller-retour Redis, et surtout dans une seule
 * exécution atomique : sans cela, deux répliques qui incrémentent en même
 * temps peuvent lire la même valeur et laisser passer une requête de trop.
 *
 * Retourne `[hits, ttlRestantMs, bloqué, ttlBlocageMs]`.
 */
const THROTTLE_SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

-- Déjà bloqué : on ne compte plus (inutile de gonfler le compteur pendant
-- qu'un client insiste) et on renvoie le temps d'attente restant.
local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  local currentHits = tonumber(redis.call('GET', hitsKey) or '0')
  local currentExpire = redis.call('PTTL', hitsKey)
  if currentExpire < 0 then currentExpire = 0 end
  return { currentHits, currentExpire, 1, blockTtl }
end

local hits = redis.call('INCR', hitsKey)
local expire = redis.call('PTTL', hitsKey)
-- Clé fraîchement créée (ou sans TTL) : on pose la fenêtre.
if expire < 0 then
  redis.call('PEXPIRE', hitsKey, ttl)
  expire = ttl
end

if hits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockDuration)
  return { hits, expire, 1, blockDuration }
end

return { hits, expire, 0, 0 }
`;

/** Client ioredis augmenté du script ci-dessus via `defineCommand`. */
type ThrottleCapableRedis = Pick<Redis, 'defineCommand'> & {
  [COMMAND_NAME]: (
    hitsKey: string,
    blockKey: string,
    ttl: string,
    limit: string,
    blockDuration: string,
  ) => Promise<[number, number, number, number]>;
};

/**
 * Stockage des compteurs dans Redis.
 *
 * Pourquoi une implémentation maison plutôt qu'un paquet tiers : les
 * adaptateurs Redis publics pour `@nestjs/throttler` suivent mal les
 * changements d'interface (`blockDuration`/`isBlocked`, arrivés en v5/v6) et
 * ajouteraient une dépendance non maintenue au chemin critique de chaque
 * requête. Le contrat `ThrottlerStorage` tient en une méthode ; `ioredis` est
 * déjà une dépendance directe du projet (sessions, BullMQ). Le coût est de
 * quelques dizaines de lignes, entièrement sous notre contrôle et testées.
 *
 * Le stockage **doit** être partagé : Dokploy peut lancer plusieurs répliques,
 * et des compteurs en mémoire de processus multiplieraient chaque limite par
 * le nombre d'instances.
 */
@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy
{
  private readonly client: ThrottleCapableRedis;

  constructor(@Inject(RATE_LIMIT_REDIS) private readonly redis: Redis) {
    this.redis.defineCommand(COMMAND_NAME, {
      numberOfKeys: 2,
      lua: THROTTLE_SCRIPT,
    });

    this.client = this.redis as unknown as ThrottleCapableRedis;
  }

  /**
   * Le nom du compteur (5ᵉ paramètre du contrat) n'est pas repris : il est
   * déjà incorporé dans `key` par `generateKey`, donc deux fenêtres d'une
   * même route ne peuvent pas se marcher dessus.
   */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): Promise<ThrottlerStorageRecord> {
    const [totalHits, timeToExpireMs, blocked, timeToBlockExpireMs] =
      await this.client[COMMAND_NAME](
        `${RATE_LIMIT_KEY_PREFIX}${key}`,
        `${RATE_LIMIT_KEY_PREFIX}${key}${RATE_LIMIT_BLOCK_KEY_SUFFIX}`,
        String(ttl),
        String(limit),
        String(blockDuration > 0 ? blockDuration : ttl),
      );

    return {
      totalHits,
      // Le contrat `ThrottlerStorage` exprime ces deux durées en secondes.
      timeToExpire: toSeconds(timeToExpireMs),
      isBlocked: blocked === 1,
      timeToBlockExpire: toSeconds(timeToBlockExpireMs),
    };
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}

function toSeconds(milliseconds: number): number {
  return Math.max(0, Math.ceil(milliseconds / 1000));
}

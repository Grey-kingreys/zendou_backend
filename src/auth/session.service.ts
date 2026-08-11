import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  SESSION_KEY_PREFIX,
  SESSION_REDIS,
  SESSION_TTL_SECONDS,
  SESSION_USER_SET_PREFIX,
} from './auth.constants';

/**
 * Stockage des sessions dans Redis : `sess:<token>` -> userId,
 * avec un TTL de 7 jours glissant (rafraîchi à chaque résolution).
 *
 * Index inverse `usersess:<userId>` -> Set<token> des sessions actives de
 * l'utilisateur, entretenu en parallèle (SADD à la création, SREM à la
 * destruction, TTL glissant rafraîchi comme la session résolue). Il permet
 * de révoquer d'un coup toutes les sessions d'un utilisateur (ex.
 * changement de mot de passe) sans SCAN sur tout Redis.
 *
 * Défensif : les sessions créées avant l'introduction de cet index
 * n'apparaissent dans aucun `usersess:<userId>` (elles n'ont jamais été
 * SADD). Elles restent des sessions valides — `resolve` continue de les
 * accepter normalement — mais `destroyAllForUser` ne peut pas les
 * retrouver ; elles seront simplement ignorées et finiront par expirer
 * naturellement via leur propre TTL.
 */
@Injectable()
export class SessionService {
  constructor(@Inject(SESSION_REDIS) private readonly redis: Redis) {}

  /** Ouvre une session et retourne le token opaque à poser en cookie. */
  async create(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const userSetKey = this.userSetKey(userId);

    await this.redis.set(this.key(token), userId, 'EX', SESSION_TTL_SECONDS);
    await this.redis.sadd(userSetKey, token);
    await this.redis.expire(userSetKey, SESSION_TTL_SECONDS);

    return token;
  }

  /**
   * Retourne l'identifiant utilisateur lié au token, ou `null` si la session
   * est absente ou expirée. Rafraîchit le TTL (session glissante) — y
   * compris celui de l'ensemble `usersess:<userId>`, pour qu'il ne périme
   * jamais avant une session encore active qu'il référence.
   */
  async resolve(token: string): Promise<string | null> {
    const key = this.key(token);
    const userId = await this.redis.get(key);

    if (!userId) {
      return null;
    }

    await this.redis.expire(key, SESSION_TTL_SECONDS);
    await this.redis.expire(this.userSetKey(userId), SESSION_TTL_SECONDS);

    return userId;
  }

  /** Supprime la session. Sans effet si elle n'existe pas. */
  async destroy(token: string): Promise<void> {
    const key = this.key(token);
    const userId = await this.redis.get(key);

    await this.redis.del(key);

    if (userId) {
      await this.redis.srem(this.userSetKey(userId), token);
    }
  }

  /**
   * Révoque toutes les sessions actives de l'utilisateur, par exemple après
   * un changement de mot de passe (voir `AuthService.changePassword`).
   * N'affecte que les sessions indexées dans `usersess:<userId>` — voir la
   * note défensive en tête de fichier pour les sessions plus anciennes.
   */
  async destroyAllForUser(userId: string): Promise<void> {
    const userSetKey = this.userSetKey(userId);
    const tokens = await this.redis.smembers(userSetKey);
    const sessionKeys = tokens.map((token) => this.key(token));

    await this.redis.del(...sessionKeys, userSetKey);
  }

  private key(token: string): string {
    return `${SESSION_KEY_PREFIX}${token}`;
  }

  private userSetKey(userId: string): string {
    return `${SESSION_USER_SET_PREFIX}${userId}`;
  }
}

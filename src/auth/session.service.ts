import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  SESSION_KEY_PREFIX,
  SESSION_REDIS,
  SESSION_TTL_SECONDS,
} from './auth.constants';

/**
 * Stockage des sessions dans Redis : `sess:<token>` -> userId,
 * avec un TTL de 7 jours glissant (rafraîchi à chaque résolution).
 */
@Injectable()
export class SessionService {
  constructor(@Inject(SESSION_REDIS) private readonly redis: Redis) {}

  /** Ouvre une session et retourne le token opaque à poser en cookie. */
  async create(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.redis.set(this.key(token), userId, 'EX', SESSION_TTL_SECONDS);
    return token;
  }

  /**
   * Retourne l'identifiant utilisateur lié au token, ou `null` si la session
   * est absente ou expirée. Rafraîchit le TTL (session glissante).
   */
  async resolve(token: string): Promise<string | null> {
    const key = this.key(token);
    const userId = await this.redis.get(key);

    if (!userId) {
      return null;
    }

    await this.redis.expire(key, SESSION_TTL_SECONDS);

    return userId;
  }

  /** Supprime la session. Sans effet si elle n'existe pas. */
  async destroy(token: string): Promise<void> {
    await this.redis.del(this.key(token));
  }

  private key(token: string): string {
    return `${SESSION_KEY_PREFIX}${token}`;
  }
}

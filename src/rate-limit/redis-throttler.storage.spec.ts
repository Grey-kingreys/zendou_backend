import type Redis from 'ioredis';
import {
  RATE_LIMIT_BLOCK_KEY_SUFFIX,
  RATE_LIMIT_KEY_PREFIX,
} from './rate-limit.constants';
import { RedisThrottlerStorage } from './redis-throttler.storage';

type ScriptResult = [number, number, number, number];

/**
 * Client ioredis factice : on vérifie que le script Lua est bien enregistré
 * une fois pour toutes (`defineCommand`) et que ses arguments sont corrects,
 * sans dépendre d'un Redis vivant dans les tests unitaires.
 */
interface DefinedCommand {
  numberOfKeys: number;
  lua: string;
}

function fakeRedis(result: ScriptResult) {
  const invocations: string[][] = [];
  const defineCommand = jest.fn<void, [string, DefinedCommand]>();
  const disconnect = jest.fn<void, []>();

  const client = {
    defineCommand,
    disconnect,
    zendouThrottle: jest.fn((...args: string[]): Promise<ScriptResult> => {
      invocations.push(args);
      return Promise.resolve(result);
    }),
  };

  return { client, invocations, defineCommand, disconnect };
}

const storageFor = (result: ScriptResult) => {
  const fake = fakeRedis(result);
  return {
    ...fake,
    storage: new RedisThrottlerStorage(fake.client as unknown as Redis),
  };
};

describe('RedisThrottlerStorage', () => {
  it('enregistre le script Lua une seule fois, sur deux clés', () => {
    const { defineCommand } = storageFor([1, 60_000, 0, 0]);

    expect(defineCommand).toHaveBeenCalledTimes(1);
    expect(defineCommand.mock.calls[0][0]).toBe('zendouThrottle');
    expect(defineCommand.mock.calls[0][1]).toMatchObject({ numberOfKeys: 2 });
  });

  it('préfixe et dérive les deux clés Redis du compteur', async () => {
    const { storage, invocations } = storageFor([1, 60_000, 0, 0]);

    await storage.increment('abc', 60_000, 5, 60_000);

    expect(invocations[0]).toEqual([
      `${RATE_LIMIT_KEY_PREFIX}abc`,
      `${RATE_LIMIT_KEY_PREFIX}abc${RATE_LIMIT_BLOCK_KEY_SUFFIX}`,
      '60000',
      '5',
      '60000',
    ]);
  });

  it('convertit en secondes les durées renvoyées en millisecondes', async () => {
    const { storage } = storageFor([3, 42_300, 0, 0]);

    await expect(storage.increment('abc', 60_000, 5, 60_000)).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 43,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('signale le blocage et le temps d’attente restant', async () => {
    const { storage } = storageFor([6, 55_000, 1, 55_000]);

    await expect(storage.increment('abc', 60_000, 5, 60_000)).resolves.toEqual({
      totalHits: 6,
      timeToExpire: 55,
      isBlocked: true,
      timeToBlockExpire: 55,
    });
  });

  it("retombe sur la fenêtre quand aucune durée de blocage n'est fournie", async () => {
    const { storage, invocations } = storageFor([1, 60_000, 0, 0]);

    await storage.increment('abc', 60_000, 5, 0);

    expect(invocations[0][4]).toBe('60000');
  });

  it('ferme le client à l’arrêt du module', () => {
    const { storage, disconnect } = storageFor([1, 60_000, 0, 0]);

    storage.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

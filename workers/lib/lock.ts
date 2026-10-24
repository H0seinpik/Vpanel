import { getEnv } from '../../src/lib/env';
import { createLogger } from './logger';

/**
 * Cross-process mutex.
 *
 * When several worker replicas run (or the inline scheduler overlaps with the
 * standalone worker), only one instance should perform a given job per tick.
 * Redis `SET key value NX PX ttl` provides that guarantee; without Redis we fall
 * back to an in-process guard, which is correct for single-instance deploys.
 */

const log = createLogger('lock');

type RedisLike = {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttl: number,
    flag: 'NX',
  ): Promise<'OK' | null>;
  del(key: string): Promise<number>;
};

let redisClient: RedisLike | null = null;
let redisUnavailable = false;

async function getRedis(): Promise<RedisLike | null> {
  if (redisUnavailable) return null;
  if (redisClient) return redisClient;

  const url = getEnv().REDIS_URL;
  if (!url) return null;

  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    client.on('error', () => {
      /* fall back to in-process locking */
    });
    await client.connect();
    redisClient = client as unknown as RedisLike;
    return redisClient;
  } catch {
    redisUnavailable = true;
    log.warn('Redis unavailable — using in-process lock only');
    return null;
  }
}

const inProcess = new Set<string>();

/**
 * Run `fn` only if the named lock is free. Returns `null` when the lock is held
 * elsewhere (the caller treats that as "another instance is already working").
 */
export async function withLock<T>(
  name: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const redis = await getRedis();

  if (redis) {
    const token = `${process.pid}-${Date.now()}`;
    try {
      const acquired = await redis.set(`vpanel:lock:${name}`, token, 'PX', ttlSeconds * 1000, 'NX');
      if (acquired !== 'OK') {
        log.debug(`lock "${name}" held by another instance — skipping`);
        return null;
      }
      try {
        return await fn();
      } finally {
        await redis.del(`vpanel:lock:${name}`).catch(() => undefined);
      }
    } catch (error) {
      log.warn(`redis lock error for "${name}", falling back`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (inProcess.has(name)) {
    log.debug(`lock "${name}" held in-process — skipping`);
    return null;
  }

  inProcess.add(name);
  try {
    return await fn();
  } finally {
    inProcess.delete(name);
  }
}

export function resetLocks() {
  inProcess.clear();
  redisClient = null;
  redisUnavailable = false;
}

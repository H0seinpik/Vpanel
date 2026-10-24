import { getEnv } from './env';

/**
 * Rate limiting.
 *
 * Uses Redis when `REDIS_URL` is configured (so limits are shared across
 * replicas) and falls back to an in-process fixed-window counter otherwise.
 * The fallback is per-instance but is enough to blunt brute-force attempts on a
 * single node deployment.
 */

interface Counter {
  count: number;
  resetAt: number;
}

const memoryStore = new Map<string, Counter>();
let lastSweep = 0;

function sweep(now: number) {
  // Opportunistic cleanup — bounded work, runs at most once per minute.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, counter] of memoryStore) {
    if (counter.resetAt <= now) memoryStore.delete(key);
  }
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

// --- Redis (lazy, optional) ---------------------------------------------------

type RedisLike = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
};

let redisClient: RedisLike | null = null;
let redisFailed = false;

async function getRedis(): Promise<RedisLike | null> {
  if (redisFailed) return null;
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
      /* handled by the fallback path */
    });
    await client.connect();
    redisClient = client as unknown as RedisLike;
    return redisClient;
  } catch {
    redisFailed = true;
    return null;
  }
}

/** Test seam. */
export function resetRateLimiter() {
  memoryStore.clear();
  redisClient = null;
  redisFailed = false;
}

// --- Public API ---------------------------------------------------------------

export async function rateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  const now = Date.now();

  const redis = await getRedis();
  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.pexpire(key, options.windowMs);
      const ttl = await redis.pttl(key);
      const resetAt = now + (ttl > 0 ? ttl : options.windowMs);
      return {
        success: count <= options.limit,
        limit: options.limit,
        remaining: Math.max(0, options.limit - count),
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    } catch {
      redisFailed = true; // fall through to memory
    }
  }

  sweep(now);
  const existing = memoryStore.get(key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + options.windowMs;
    memoryStore.set(key, { count: 1, resetAt });
    return {
      success: true,
      limit: options.limit,
      remaining: options.limit - 1,
      resetAt,
      retryAfterSeconds: Math.ceil(options.windowMs / 1000),
    };
  }

  existing.count += 1;
  const remaining = Math.max(0, options.limit - existing.count);
  return {
    success: existing.count <= options.limit,
    limit: options.limit,
    remaining,
    resetAt: existing.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

/** Convenience presets used across the API. */
export const RATE_LIMITS = {
  login: { limit: 8, windowMs: 5 * 60_000 },
  refresh: { limit: 60, windowMs: 5 * 60_000 },
  write: { limit: 120, windowMs: 60_000 },
  read: { limit: 600, windowMs: 60_000 },
  sensitive: { limit: 10, windowMs: 60_000 },
} as const;

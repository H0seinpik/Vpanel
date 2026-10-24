import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getEnv } from '@/lib/env';
import { readWorkerLock, readWorkerHeartbeat } from '@/services/worker-lock';

/**
 * A health probe must never be cached.
 *
 * This route reads live process state (the lock holder, the worker heartbeat), so
 * a cached response is not merely stale — it is actively misleading. Observed:
 * the endpoint kept returning the *previous* worker's pid and a timestamp from
 * 15 minutes earlier, which would have hidden exactly the wedged-worker condition
 * the heartbeat was added to expose. Force dynamic rendering and no-store.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
} as const;

/**
 * GET /api/health
 *
 * Liveness + readiness probe for Docker/nginx/Prometheus. Reports database
 * connectivity, the active node provider and worker configuration. Never
 * exposes secrets.
 *
 * Also reports the node-config lock holder. Exactly one worker may own the
 * config; two writers once wiped `config.json` and took every port down for
 * ~12 minutes, so "is a worker alive and is there only one" is now part of
 * readiness rather than something to discover during an incident.
 */
export async function GET() {
  const env = getEnv();
  const startedAt = Date.now();

  let database: 'ok' | 'error' = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'error';
  }

  const { info: lockHolder, alive: lockAlive } = readWorkerLock(env.XRAY_DIR);
  const { ageMs: heartbeatAgeMs, wedged: workerWedged } = readWorkerHeartbeat(env.XRAY_DIR);

  // A wedged worker is a real outage even though every other probe passes: the
  // node is unmanaged and the lock blocks a replacement. Report it as degraded.
  const healthy = database === 'ok' && !workerWedged;

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      version: process.env.APP_VERSION ?? '1.0.0',
      environment: env.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
      checks: {
        database,
        latencyMs: Date.now() - startedAt,
      },
      providers: {
        node: env.NODE_PROVIDER,
        redis: env.REDIS_URL ? 'configured' : 'disabled',
      },
      workers: {
        trafficIntervalSeconds: env.TRAFFIC_INTERVAL_SECONDS,
        monitorIntervalSeconds: env.MONITOR_INTERVAL_SECONDS,
        inlineWorker: env.ENABLE_INLINE_WORKER,
        /**
         * The single writer of the node config.
         *
         * `lockAlive: false` with a non-null holder means a worker died without
         * releasing — the next start reclaims it. `lockHolder: null` means the
         * node config is currently unmanaged.
         */
        configLock: {
          holder: lockHolder
            ? { pid: lockHolder.pid, role: lockHolder.role, startedAt: lockHolder.startedAt }
            : null,
          alive: lockAlive,
        },
        /**
         * Is the lock holder actually *working*?
         *
         * `alive: true` above only proves a pid exists. A worker whose job loops
         * have stopped still holds the lock and still answers HTTP — and that is
         * worse than a dead one, because the lock blocks a replacement. On
         * 2026-09-28 that state lasted over an hour before anyone noticed.
         * `wedged: true` means no job has completed for 90 s.
         */
        heartbeat: {
          ageSeconds: heartbeatAgeMs === null ? null : Math.round(heartbeatAgeMs / 1000),
          wedged: workerWedged,
        },
      },
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503, headers: NO_STORE },
  );
}

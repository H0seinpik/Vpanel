import { getEnv } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';
import { acquireWorkerLock, releaseWorkerLock, writeWorkerHeartbeat, clearWorkerHeartbeat } from '../src/services/worker-lock';
import { runTrafficCollection } from './traffic-worker';
import { runMonitoringPass } from './monitor-worker';
import { runEnforcementPass } from './enforcement-worker';
import { runXrayReconcile } from './xray-worker';
import { createLogger } from './lib/logger';

/**
 * Worker entrypoint.
 *
 *   npm run worker            # daemon: runs all jobs on their intervals
 *   npm run worker -- traffic # run the traffic collection pass once, then exit
 *   npm run worker -- monitor # run the monitoring pass once, then exit
 *   npm run worker -- enforce # run the enforcement pass once, then exit
 *   npm run worker -- xray    # reconcile the node config once, then exit
 *   npm run worker -- all     # run every pass once, then exit
 *
 * Running as a separate container keeps long-lived schedulers out of the web
 * process, which is what you want in production. For local development you can
 * instead set ENABLE_INLINE_WORKER=true and let the Next.js server drive it.
 */

const log = createLogger('scheduler');

type JobName = 'traffic' | 'monitor' | 'enforce' | 'xray';

const JOBS: Record<JobName, () => Promise<unknown>> = {
  traffic: runTrafficCollection,
  monitor: runMonitoringPass,
  enforce: runEnforcementPass,
  xray: runXrayReconcile,
};

/**
 * A record of when each job last completed, plus a counter for failures.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-09-28 a worker process stayed alive, kept holding `.vpanel-worker.lock`,
 * and answered `GET /api/health` — while *none* of its job loops had run for over
 * an hour (`xray-worker` last logged at 06:28, the process started at 06:59 and
 * never logged once). The node drifted, traffic stopped being collected, ceilings
 * stopped being enforced, and Xray ended up an orphan.
 *
 * A wedged-but-alive worker is worse than a dead one: the single-writer lock it
 * holds blocks a healthy replacement from starting. So the daemon now records a
 * heartbeat after every job run and a watchdog restarts the process if the
 * heartbeat goes stale — the lock is released on the way out, so the replacement
 * can take over immediately.
 */
interface Heartbeat {
  at: number;
  runs: number;
  failures: number;
  lastError?: string;
}

const heartbeats = new Map<JobName, Heartbeat>();

export function getJobHeartbeats(): Record<string, Heartbeat> {
  const out: Record<string, Heartbeat> = {};
  for (const [name, beat] of heartbeats) out[name] = beat;
  return out;
}

/**
 * Persist the in-memory heartbeats so the web process (a different process, which
 * cannot see this Map) can tell "working" from "wedged". Written after every job
 * run — cheap, and it is the only cross-process signal that the loops are live.
 */
function persistHeartbeat(): void {
  writeWorkerHeartbeat(getEnv().XRAY_DIR, {
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    jobs: getJobHeartbeats(),
  });
}

async function safeRun(name: JobName, fn: () => Promise<unknown>) {
  try {
    await fn();
    const previous = heartbeats.get(name);
    heartbeats.set(name, {
      at: Date.now(),
      runs: (previous?.runs ?? 0) + 1,
      failures: previous?.failures ?? 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const previous = heartbeats.get(name);
    heartbeats.set(name, {
      // A failure still proves the loop is alive, so the heartbeat advances.
      at: Date.now(),
      runs: previous?.runs ?? 0,
      failures: (previous?.failures ?? 0) + 1,
      lastError: message,
    });
    log.error(`job "${name}" failed`, {
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    persistHeartbeat();
  }
}

export interface SchedulerHandle {
  stop: () => void;
  /** The interval each job actually runs on, so the watchdog scales to it. */
  intervals: Record<JobName, number>;
}

/**
 * The watchdog timer. `undefined` until `startScheduler()` runs in daemon mode.
 *
 * THE THRESHOLD MUST EXCEED THE JOB'S OWN INTERVAL — this is the whole subtlety.
 * A first version used a flat 90 s. The traffic job runs every 120 s, so a
 * perfectly healthy loop is routinely silent for up to two minutes; the watchdog
 * killed it, logged "worker is wedged", and restarted the process every ~2 min.
 * A watchdog more eager than the schedule it watches is a self-inflicted outage.
 *
 * So each job gets its own allowance: `intervalMs * 3 + 30 s`. Three missed
 * periods is unambiguous, and the slack absorbs a slow pass. The `xray` job
 * (15 s) therefore trips at 75 s, `traffic` (120 s) at 390 s.
 */
let watchdog: ReturnType<typeof setInterval> | undefined;

/**
 * How long a job may go without completing before we call the worker wedged.
 *
 * Pure and exported so it is unit-tested — the failure it prevents is subtle and
 * silent: a threshold at or below the job's own interval makes a healthy worker
 * look dead, and the watchdog then restarts it forever. Three missed periods
 * plus 30 s of slack.
 */
export function watchdogAllowanceMs(intervalMs: number): number {
  return intervalMs * 3 + 30_000;
}

function startWatchdog(intervals: Record<JobName, number>): void {
  const critical: JobName[] = ['xray', 'traffic'];

  const allowance = (name: JobName) => watchdogAllowanceMs(intervals[name]);

  // Check often enough to react promptly on the tightest job, but never faster
  // than that job could legitimately report.
  const xrayAllowance = allowance('xray');
  const tickMs = Math.max(5_000, Math.min(Math.floor(xrayAllowance / 3), 30_000));

  watchdog = setInterval(() => {
    const now = Date.now();
    for (const name of critical) {
      const beat = heartbeats.get(name);
      if (!beat) continue; // not yet run once; the initial kick will set it
      const allowed = allowance(name);
      const age = now - beat.at;
      if (age > allowed) {
        log.error('watchdog: worker is wedged — restarting to restore the node', {
          job: name,
          staleSeconds: Math.round(age / 1000),
          thresholdSeconds: Math.round(allowed / 1000),
          intervalSeconds: Math.round(intervals[name] / 1000),
          runs: beat.runs,
          failures: beat.failures,
          lastError: beat.lastError,
        });
        // Release the lock so a replacement can claim it immediately. The stale
        // heartbeat is deliberately LEFT IN PLACE: it is the evidence the panel
        // shows for why this worker was restarted.
        releaseWorkerLock(getEnv().XRAY_DIR);
        // Non-zero so the supervisor knows this was not a clean stop.
        process.exit(3);
      }
    }
  }, tickMs);
}

/** Start all periodic jobs. Returns a handle so callers can stop them. */
export function startScheduler(): SchedulerHandle {
  const env = getEnv();
  const trafficMs = env.TRAFFIC_INTERVAL_SECONDS * 1000;
  const monitorMs = env.MONITOR_INTERVAL_SECONDS * 1000;
  // Enforcement is comparatively expensive; five traffic windows is plenty.
  const enforceMs = Math.max(trafficMs * 5, 300_000);
  // Reconcile often: config drift is what a user notices immediately.
  const xrayMs = 15_000;

  log.info('scheduler starting', {
    trafficIntervalSeconds: env.TRAFFIC_INTERVAL_SECONDS,
    monitorIntervalSeconds: env.MONITOR_INTERVAL_SECONDS,
    enforceIntervalSeconds: enforceMs / 1000,
    xrayReconcileSeconds: xrayMs / 1000,
    provider: env.NODE_PROVIDER,
    xrayEnabled: env.XRAY_ENABLED,
  });

  // Kick off immediately so a fresh deployment shows data without waiting.
  void safeRun('xray', JOBS.xray);
  void safeRun('traffic', JOBS.traffic);
  void safeRun('monitor', JOBS.monitor);
  void safeRun('enforce', JOBS.enforce);

  const timers = [
    setInterval(() => void safeRun('xray', JOBS.xray), xrayMs),
    setInterval(() => void safeRun('traffic', JOBS.traffic), trafficMs),
    setInterval(() => void safeRun('monitor', JOBS.monitor), monitorMs),
    setInterval(() => void safeRun('enforce', JOBS.enforce), enforceMs),
  ];

  return {
    intervals: { xray: xrayMs, traffic: trafficMs, monitor: monitorMs, enforce: enforceMs },
    stop: () => {
      timers.forEach((timer) => clearInterval(timer));
      watchdog && clearInterval(watchdog);
      log.info('scheduler stopped');
    },
  };
}

async function main() {
  const mode = (process.argv[2] ?? 'daemon').toLowerCase();

  if (mode === 'daemon') {
    // Exactly one process may ever drive the reconcile loop. Two writers to
    // config.json rendered contradictory configs on 2026-09-28 and one of them
    // wiped the file, taking every port down for ~12 minutes. Refuse to become
    // a second writer rather than risk repeating that.
    const lock = acquireWorkerLock({
      xrayDir: getEnv().XRAY_DIR,
      role: 'worker daemon',
    });

    if (!lock.acquired) {
      log.error('refusing to start: another worker owns the node config', {
        reason: lock.reason,
        holderPid: lock.holder?.pid,
        holderStartedAt: lock.holder?.startedAt,
        fix: 'Stop the other worker first — only one may run. See .vpanel/proc-map.ts',
      });
      await prisma.$disconnect().catch(() => undefined);
      process.exitCode = 2;
      return;
    }

    if (lock.reclaimedFrom !== undefined) {
      log.warn('reclaimed the node config lock from a dead worker', {
        deadPid: lock.reclaimedFrom,
      });
    }

    log.info('worker started — this process owns the node config', {
      pid: lock.info.pid,
    });

    const handle = startScheduler();
    // Scale the watchdog to each job's real interval. A fixed threshold below a
    // job's own period makes the watchdog kill healthy workers — see the note on
    // startWatchdog().
    startWatchdog(handle.intervals);

    // A floating promise anywhere in a job must never take the whole worker down
    // silently — and must never leave it wedged while still holding the lock.
    // Log, release the lock, and exit non-zero so the supervisor restarts us.
    const fatal = (kind: string, error: unknown) => {
      log.error(`fatal ${kind} — releasing the node config lock and exiting`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Leave the heartbeat: it is the record of when this worker was last well.
      releaseWorkerLock(getEnv().XRAY_DIR);
      process.exit(4);
    };
    process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
    process.on('uncaughtException', (error) => fatal('uncaughtException', error));

    const shutdown = async (signal: string) => {
      log.info(`received ${signal} — shutting down`);
      handle.stop();
      releaseWorkerLock(getEnv().XRAY_DIR);
      clearWorkerHeartbeat(getEnv().XRAY_DIR);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    return;
  }

  if (mode === 'all') {
    await safeRun('xray', JOBS.xray);
    await safeRun('traffic', JOBS.traffic);
    await safeRun('monitor', JOBS.monitor);
    await safeRun('enforce', JOBS.enforce);
  } else if (mode === 'traffic' || mode === 'monitor' || mode === 'enforce' || mode === 'xray') {
    await safeRun(mode, JOBS[mode]);
  } else {
    log.error(`unknown mode "${mode}"`, {
      valid: ['daemon', 'traffic', 'monitor', 'enforce', 'xray', 'all'],
    });
    process.exitCode = 1;
  }

  await prisma.$disconnect().catch(() => undefined);
}

// Only run the CLI when executed directly (not when imported by the app).
if (require.main === module) {
  void main();
}

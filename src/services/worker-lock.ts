/**
 * Single-writer lock for the node config.
 *
 * WHY THIS EXISTS
 * ---------------
 * `config.json` has exactly one writer by design: the worker's reconcile job.
 * On 2026-09-28 two worker processes were running at the same time and both
 * drove the 15 s reconcile loop. They rendered contradictory configs within the
 * same minute and one of them wrote a fully empty file, which took every port
 * down for ~12 minutes (`context deadline exceeded` for every client).
 *
 * Two workers appear easily: a `next start` that inline-starts the scheduler
 * (`ENABLE_INLINE_WORKER=true`) plus a standalone `npm run worker daemon`, or
 * simply starting the daemon twice and never noticing. Nothing detected it.
 *
 * This lock makes a second writer impossible. The first process to start takes
 * the lock; a later process either exits or, when explicitly allowed, reclaims
 * the lock from a process that is provably dead. It is deliberately conservative
 * — it will refuse to start rather than risk a second writer.
 *
 * The file holds the owner pid. Liveness is decided by probing the pid, so a
 * crashed worker never leaves the node permanently unmanaged.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LockInfo {
  pid: number;
  startedAt: string;
  host?: string;
  role: string;
}

export type LockOutcome =
  | { acquired: true; info: LockInfo; reclaimedFrom?: number }
  | { acquired: false; holder: LockInfo | null; reason: string };

/**
 * Is a pid alive on this machine?
 *
 * `process.kill(pid, 0)` is the portable test: it throws ESRCH when nothing has
 * that pid and EPERM when the process exists but belongs to someone else (still
 * alive, so still the owner). On Windows a reused pid is a theoretical risk —
 * acceptable here because the lock is short-lived and the cost of a false
 * "alive" is one refused start, not a wrong write.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Where the lock lives. Kept beside the node state so it travels with XRAY_DIR. */
export function lockPathFor(xrayDir: string): string {
  return join(xrayDir, '.vpanel-worker.lock');
}

function readLock(path: string): LockInfo | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : 'unknown',
      host: typeof parsed.host === 'string' ? parsed.host : undefined,
      role: typeof parsed.role === 'string' ? parsed.role : 'worker',
    };
  } catch {
    // A corrupt lock is treated as absent — it cannot be trusted, and refusing
    // to start forever because of a half-written file is its own outage.
    return null;
  }
}

/**
 * Claim the single-writer lock.
 *
 * `allowReclaim` (default true) lets a starting process take over when the
 * recorded owner is provably dead. Set it to false when you want a hard refusal
 * — useful in tests and when an operator explicitly wants to be told rather
 * than have the old owner replaced.
 */
export function acquireWorkerLock(options: {
  xrayDir: string;
  role?: string;
  allowReclaim?: boolean;
}): LockOutcome {
  const path = lockPathFor(options.xrayDir);
  const role = options.role ?? 'worker';
  const allowReclaim = options.allowReclaim ?? true;
  const self = process.pid;

  const existing = readLock(path);

  if (existing && existing.pid !== self && isPidAlive(existing.pid)) {
    return {
      acquired: false,
      holder: existing,
      reason:
        `another ${existing.role} is already running (pid ${existing.pid}, ` +
        `started ${existing.startedAt}). Two writers to config.json can take the ` +
        `node down — refusing to start a second one.`,
    };
  }

  const reclaimedFrom =
    existing && existing.pid !== self && !isPidAlive(existing.pid) ? existing.pid : undefined;

  if (existing && existing.pid !== self && !isPidAlive(existing.pid) && !allowReclaim) {
    return {
      acquired: false,
      holder: existing,
      reason: `stale lock held by dead pid ${existing.pid} and reclaim is disabled`,
    };
  }

  const info: LockInfo = {
    pid: self,
    startedAt: new Date().toISOString(),
    host: process.env.COMPUTERNAME ?? process.env.HOSTNAME,
    role,
  };

  mkdirSync(dirname(path), { recursive: true });
  // Write to a pid-unique temp file then rename over the lock, so a concurrent
  // reader never observes a half-written file.
  const temp = `${path}.tmp.${self}`;
  writeFileSync(temp, JSON.stringify(info, null, 2), 'utf8');
  try {
    rmSync(path, { force: true });
  } catch {
    // Windows occasionally refuses the unlink while a handle is open; the
    // rename below still replaces it.
  }
  try {
    renameSync(temp, path);
  } catch {
    // Cross-device or a locked target: fall back to a direct write.
    writeFileSync(path, JSON.stringify(info, null, 2), 'utf8');
    rmSync(temp, { force: true });
  }

  return { acquired: true, info, reclaimedFrom };
}

/** Release the lock, but only if we still own it. */
export function releaseWorkerLock(xrayDir: string): void {
  const path = lockPathFor(xrayDir);
  const holder = readLock(path);
  if (holder && holder.pid !== process.pid) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // Non-fatal: a dead owner's lock is reclaimed on the next start anyway.
  }
}

/**
 * Read the current holder without touching it. Used by diagnostics
 * (`client:doctor`) and by the panel's health page.
 */
export function readWorkerLock(xrayDir: string): { info: LockInfo | null; alive: boolean } {
  const info = readLock(lockPathFor(xrayDir));
  return { info, alive: info ? isPidAlive(info.pid) : false };
}

export type NodeWriteVerdict =
  | { mayWrite: true; reason: 'lock-free' | 'we-own-the-lock' | 'owner-is-dead' }
  | { mayWrite: false; reason: 'held-by-another-live-process'; holder: LockInfo };

/**
 * May THIS process write `config.json`?
 *
 * The lock was originally only about stopping two *workers* from starting. But
 * the panel is also a writer: every configuration mutation calls
 * `triggerXraySync()`, which runs `syncXray()` → `renderXrayConfig()` → a write
 * to `config.json`. Nothing stopped the panel from reconciling while a worker was
 * mid-reconcile, and nothing stopped the panel from rendering from **stale
 * in-memory code** — which is exactly how "I fixed it but the node reverted"
 * happens.
 *
 * Observed 2026-09-28: xray.exe's recorded parent was the panel
 * (`next start`, pid 7000) rather than the worker, i.e. the *panel* spawned the
 * node process. Two writers, one file, no mutual exclusion.
 *
 * So: a process may write only if it owns the lock, or if the recorded owner is
 * **dead** (nothing is managing the node, so any writer is an improvement). A
 * live owner is authoritative — even if that owner is the panel itself.
 *
 * Note this is a *soft* guard: it is advisory, not an OS mutex, so a genuine
 * race window remains between the check and the write. That is acceptable here
 * because both writers now take the same decision, and the outcome of a lost
 * race is a duplicate identical render (writes are hash-gated) rather than
 * contradictory state.
 */
export function mayWriteNodeConfig(xrayDir: string): NodeWriteVerdict {
  const info = readLock(lockPathFor(xrayDir));
  if (!info) return { mayWrite: true, reason: 'lock-free' };
  if (info.pid === process.pid) return { mayWrite: true, reason: 'we-own-the-lock' };
  if (!isPidAlive(info.pid)) return { mayWrite: true, reason: 'owner-is-dead' };
  return { mayWrite: false, reason: 'held-by-another-live-process', holder: info };
}

// -----------------------------------------------------------------------------
// Heartbeat — is the worker actually *working*, or merely alive?
// -----------------------------------------------------------------------------

/**
 * A worker that holds the lock and answers HTTP but whose job loops have stopped
 * is the most dangerous state this system has: the node goes unmanaged AND the
 * lock blocks a healthy replacement from starting. Observed 2026-09-28 — pid 1972
 * started at 06:59 and never logged a single line, while the previous worker's
 * last `xray-worker` entry was 06:28. `readWorkerLock()` said `alive: true`.
 *
 * So the worker also writes a heartbeat after every job run, and the panel reads
 * it to distinguish "running" from "wedged".
 */
export interface WorkerHeartbeat {
  pid: number;
  updatedAt: string;
  /** Per-job counters: how many times it ran, how many failed, when it last did either. */
  jobs: Record<string, { at: number; runs: number; failures: number; lastError?: string }>;
}

export function heartbeatPathFor(xrayDir: string): string {
  return join(xrayDir, '.vpanel-worker.heartbeat');
}

/**
 * Write the heartbeat. Best-effort: a failure here must never break a job.
 *
 * Written to a temp file and renamed into place. A plain `writeFileSync` leaves a
 * window where a concurrent reader sees a *partially written* file; `JSON.parse`
 * then throws and the reader concludes "no heartbeat". That is harmless for the
 * panel's display, but the watchdog treats a missing heartbeat as "the worker is
 * down" and would restart a perfectly healthy stack. The rename is atomic on
 * Windows, so a reader sees either the old file or the new one.
 */
export function writeWorkerHeartbeat(xrayDir: string, heartbeat: WorkerHeartbeat): void {
  const path = heartbeatPathFor(xrayDir);
  const temp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, JSON.stringify(heartbeat, null, 2), 'utf8');
    renameSync(temp, path);
  } catch {
    // Non-fatal — the heartbeat is an observability aid, not a control input.
  }
}

/**
 * Read the heartbeat and judge whether the worker is actually working.
 *
 * `wedged: true` means the process is alive and holds the lock but no job has
 * completed within `staleMs` (default 90 s — six missed reconcile ticks). The
 * panel surfaces this so the operator sees it before clients do.
 */
export function readWorkerHeartbeat(
  xrayDir: string,
  staleMs = 90_000,
): { heartbeat: WorkerHeartbeat | null; ageMs: number | null; wedged: boolean } {
  const path = heartbeatPathFor(xrayDir);
  if (!existsSync(path)) return { heartbeat: null, ageMs: null, wedged: false };
  try {
    const heartbeat = JSON.parse(readFileSync(path, 'utf8')) as WorkerHeartbeat;
    const updated = Date.parse(heartbeat.updatedAt);
    if (Number.isNaN(updated)) return { heartbeat, ageMs: null, wedged: false };
    const ageMs = Date.now() - updated;
    const alive = isPidAlive(heartbeat.pid);
    return { heartbeat, ageMs, wedged: alive && ageMs > staleMs };
  } catch {
    return { heartbeat: null, ageMs: null, wedged: false };
  }
}

/** Remove the heartbeat on a clean stop, so a restart never shows a stale one. */
export function clearWorkerHeartbeat(xrayDir: string): void {
  try {
    rmSync(heartbeatPathFor(xrayDir), { force: true });
  } catch {
    // Non-fatal.
  }
}

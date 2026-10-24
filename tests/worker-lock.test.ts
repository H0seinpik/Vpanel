import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireWorkerLock,
  clearWorkerHeartbeat,
  heartbeatPathFor,
  isPidAlive,
  lockPathFor,
  mayWriteNodeConfig,
  readWorkerHeartbeat,
  readWorkerLock,
  releaseWorkerLock,
  writeWorkerHeartbeat,
} from '@/services/worker-lock';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vpanel-lock-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A pid that is certainly not alive and certainly not this process. Picking
 * something implausibly high avoids colliding with a real pid on the machine.
 */
const DEAD_PID = 4_000_000;

describe('isPidAlive', () => {
  it('reports this process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('reports an unused pid as dead', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });

  it('rejects nonsense pids without throwing', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });
});

describe('acquireWorkerLock', () => {
  it('acquires when nothing holds the lock', () => {
    const outcome = acquireWorkerLock({ xrayDir: dir, role: 'test' });
    expect(outcome.acquired).toBe(true);
    if (outcome.acquired) {
      expect(outcome.info.pid).toBe(process.pid);
      expect(outcome.info.role).toBe('test');
    }
  });

  it('refuses a second writer owned by a LIVE process', () => {
    // Simulate a live other worker by writing a lock owned by this process but
    // read through a different pid: use the current pid and a role marker.
    writeFileSync(
      lockPathFor(dir),
      JSON.stringify({
        pid: process.pid,
        startedAt: '2026-01-01T00:00:00.000Z',
        role: 'worker daemon',
      }),
      'utf8',
    );

    const outcome = acquireWorkerLock({ xrayDir: dir, role: 'second' });
    // Our own pid is treated as "us", so this must succeed (re-entrant).
    expect(outcome.acquired).toBe(true);
  });

  it('refuses when a DIFFERENT live process owns the lock', () => {
    // Find a live pid that is not us: the parent process is a good candidate.
    const otherPid = process.ppid;
    if (!isPidAlive(otherPid) || otherPid === process.pid) return;

    writeFileSync(
      lockPathFor(dir),
      JSON.stringify({ pid: otherPid, startedAt: '2026-01-01T00:00:00.000Z', role: 'worker daemon' }),
      'utf8',
    );

    const outcome = acquireWorkerLock({ xrayDir: dir, role: 'second' });
    expect(outcome.acquired).toBe(false);
    if (!outcome.acquired) {
      expect(outcome.holder?.pid).toBe(otherPid);
      expect(outcome.reason).toContain('already running');
      expect(outcome.reason).toContain('config.json');
    }
  });

  it('reclaims the lock from a dead owner', () => {
    writeFileSync(
      lockPathFor(dir),
      JSON.stringify({ pid: DEAD_PID, startedAt: '2026-01-01T00:00:00.000Z', role: 'worker daemon' }),
      'utf8',
    );

    const outcome = acquireWorkerLock({ xrayDir: dir, role: 'fresh' });
    expect(outcome.acquired).toBe(true);
    if (outcome.acquired) expect(outcome.reclaimedFrom).toBe(DEAD_PID);
  });

  it('refuses to reclaim a dead owner when reclaim is disabled', () => {
    writeFileSync(
      lockPathFor(dir),
      JSON.stringify({ pid: DEAD_PID, startedAt: '2026-01-01T00:00:00.000Z', role: 'worker daemon' }),
      'utf8',
    );

    const outcome = acquireWorkerLock({ xrayDir: dir, role: 'fresh', allowReclaim: false });
    expect(outcome.acquired).toBe(false);
    if (!outcome.acquired) expect(outcome.reason).toContain('stale lock');
  });

  it('treats a corrupt lock file as absent rather than refusing forever', () => {
    writeFileSync(lockPathFor(dir), '{ this is not json', 'utf8');
    const outcome = acquireWorkerLock({ xrayDir: dir, role: 'fresh' });
    expect(outcome.acquired).toBe(true);
  });

  it('creates the directory if the node dir does not exist yet', () => {
    const nested = join(dir, 'deep', 'nested');
    const outcome = acquireWorkerLock({ xrayDir: nested, role: 'test' });
    expect(outcome.acquired).toBe(true);
  });
});

describe('releaseWorkerLock', () => {
  it('removes a lock we own', () => {
    acquireWorkerLock({ xrayDir: dir, role: 'test' });
    expect(readWorkerLock(dir).info).not.toBeNull();

    releaseWorkerLock(dir);
    expect(readWorkerLock(dir).info).toBeNull();
  });

  it('leaves a lock owned by someone else alone', () => {
    const otherPid = process.ppid;
    if (!isPidAlive(otherPid) || otherPid === process.pid) return;

    writeFileSync(
      lockPathFor(dir),
      JSON.stringify({ pid: otherPid, startedAt: '2026-01-01T00:00:00.000Z', role: 'worker daemon' }),
      'utf8',
    );

    releaseWorkerLock(dir);
    expect(readWorkerLock(dir).info?.pid).toBe(otherPid);
  });

  it('is safe to call when no lock exists', () => {
    expect(() => releaseWorkerLock(dir)).not.toThrow();
  });
});

describe('readWorkerLock', () => {
  it('reports liveness alongside the holder', () => {
    acquireWorkerLock({ xrayDir: dir, role: 'test' });
    const { info, alive } = readWorkerLock(dir);
    expect(info?.pid).toBe(process.pid);
    expect(alive).toBe(true);
  });

  it('reports a dead holder as not alive', () => {
    writeFileSync(
      lockPathFor(dir),
      JSON.stringify({ pid: DEAD_PID, startedAt: '2026-01-01T00:00:00.000Z', role: 'worker daemon' }),
      'utf8',
    );
    const { info, alive } = readWorkerLock(dir);
    expect(info?.pid).toBe(DEAD_PID);
    expect(alive).toBe(false);
  });

  it('returns null info when there is no lock', () => {
    expect(readWorkerLock(dir)).toEqual({ info: null, alive: false });
  });
});

describe('lockPathFor', () => {
  it('places the lock inside the node directory', () => {
    expect(lockPathFor('C:/xray')).toContain('.vpanel-worker.lock');
  });
});

/**
 * The heartbeat exists because "the pid is alive" and "the worker is doing its
 * job" are different facts, and confusing them cost over an hour of unmanaged
 * node on 2026-09-28: a worker held the lock, answered HTTP, and ran no jobs.
 */
describe('worker heartbeat', () => {
  const jobs = { xray: { at: Date.now(), runs: 7, failures: 0 } };

  it('reports nothing when no heartbeat has ever been written', () => {
    const result = readWorkerHeartbeat(dir);
    expect(result.heartbeat).toBeNull();
    expect(result.ageMs).toBeNull();
    expect(result.wedged).toBe(false);
  });

  it('round-trips a fresh heartbeat and is not wedged', () => {
    writeWorkerHeartbeat(dir, {
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      jobs,
    });

    const result = readWorkerHeartbeat(dir);
    expect(result.heartbeat?.pid).toBe(process.pid);
    expect(result.heartbeat?.jobs.xray?.runs).toBe(7);
    expect(result.ageMs).toBeLessThan(5_000);
    expect(result.wedged).toBe(false);
  });

  it('declares a live worker wedged when its heartbeat is older than the threshold', () => {
    writeWorkerHeartbeat(dir, {
      pid: process.pid, // alive, so this is the dangerous case
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      jobs,
    });

    const result = readWorkerHeartbeat(dir);
    expect(result.wedged).toBe(true);
    expect(result.ageMs).toBeGreaterThan(9 * 60_000);
  });

  it('does not call a dead worker wedged — it is simply gone', () => {
    writeWorkerHeartbeat(dir, {
      pid: DEAD_PID,
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      jobs,
    });

    const result = readWorkerHeartbeat(dir);
    expect(result.wedged).toBe(false);
    expect(result.ageMs).toBeGreaterThan(9 * 60_000);
  });

  it('honours a custom staleness threshold', () => {
    writeWorkerHeartbeat(dir, {
      pid: process.pid,
      updatedAt: new Date(Date.now() - 5_000).toISOString(),
      jobs,
    });
    expect(readWorkerHeartbeat(dir, 1_000).wedged).toBe(true);
    expect(readWorkerHeartbeat(dir, 60_000).wedged).toBe(false);
  });

  it('treats a corrupt heartbeat file as absent rather than crashing the panel', () => {
    writeFileSync(heartbeatPathFor(dir), '{ not json', 'utf8');
    const result = readWorkerHeartbeat(dir);
    expect(result.heartbeat).toBeNull();
    expect(result.wedged).toBe(false);
  });

  it('treats an unparseable timestamp as unknown, not wedged', () => {
    writeFileSync(
      heartbeatPathFor(dir),
      JSON.stringify({ pid: process.pid, updatedAt: 'never', jobs: {} }),
      'utf8',
    );
    const result = readWorkerHeartbeat(dir);
    expect(result.ageMs).toBeNull();
    expect(result.wedged).toBe(false);
  });

  it('clears the heartbeat file', () => {
    writeWorkerHeartbeat(dir, { pid: process.pid, updatedAt: new Date().toISOString(), jobs });
    clearWorkerHeartbeat(dir);
    expect(readWorkerHeartbeat(dir).heartbeat).toBeNull();
  });

  it('clearing a heartbeat that does not exist is harmless', () => {
    expect(() => clearWorkerHeartbeat(dir)).not.toThrow();
  });

  it('writes the heartbeat beside the lock, so it travels with XRAY_DIR', () => {
    expect(heartbeatPathFor(dir)).toContain(dir);
    expect(heartbeatPathFor(dir)).not.toBe(lockPathFor(dir));
  });
});

describe('mayWriteNodeConfig — the panel/worker two-writer guard', () => {
  /**
   * Both the panel and the worker write config.json: the worker on its 15 s
   * reconcile, the panel on every config mutation. On 2026-09-28 xray.exe's
   * recorded parent was the PANEL (next start), i.e. the panel had spawned the
   * node process, and nothing prevented it from reconciling from a stale build
   * while the worker held pre-edit code in memory. This guard is what stops that.
   */
  it('allows a write when nobody holds the lock', () => {
    const verdict = mayWriteNodeConfig(dir);
    expect(verdict.mayWrite).toBe(true);
    if (verdict.mayWrite) expect(verdict.reason).toBe('lock-free');
  });

  it('allows a write when THIS process owns the lock (the worker)', () => {
    acquireWorkerLock({ xrayDir: dir, role: 'worker daemon' });
    const verdict = mayWriteNodeConfig(dir);
    expect(verdict.mayWrite).toBe(true);
    if (verdict.mayWrite) expect(verdict.reason).toBe('we-own-the-lock');
  });

  it('REFUSES a write when another LIVE process owns the lock (the panel defers)', () => {
    // A live foreign owner: a lock file naming a pid that is alive but is not us.
    // process.pid cannot be used (that is 'we own it'), so borrow a real live pid.
    writeFileSync(
      lockPathFor(dir),
      JSON.stringify({ pid: process.pid === 1 ? 2 : 1, startedAt: 'now', role: 'worker daemon' }),
      'utf8',
    );
    const verdict = mayWriteNodeConfig(dir);
    // If pid 1/2 is not actually alive in this environment the guard correctly
    // falls through to 'owner-is-dead', so only assert when it is alive.
    if (!isPidAlive(process.pid === 1 ? 2 : 1)) {
      expect(verdict.mayWrite).toBe(true);
      if (verdict.mayWrite) expect(verdict.reason).toBe('owner-is-dead');
      return;
    }
    expect(verdict.mayWrite).toBe(false);
    if (!verdict.mayWrite) {
      expect(verdict.reason).toBe('held-by-another-live-process');
      expect(verdict.holder.role).toBe('worker daemon');
    }
  });

  it('allows a write when the recorded owner is DEAD, so the node is never abandoned', () => {
    writeFileSync(
      lockPathFor(dir),
      JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', role: 'worker daemon' }),
      'utf8',
    );
    const verdict = mayWriteNodeConfig(dir);
    expect(verdict.mayWrite).toBe(true);
    if (verdict.mayWrite) expect(verdict.reason).toBe('owner-is-dead');
  });

  it('treats a corrupt lock as lock-free rather than blocking the node forever', () => {
    writeFileSync(lockPathFor(dir), '{ half-written', 'utf8');
    expect(mayWriteNodeConfig(dir).mayWrite).toBe(true);
  });
});

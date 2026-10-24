import { prisma } from '../src/lib/prisma';
import { getEnv } from '../src/lib/env';
import { assignmentIdFromEmail } from '../src/services/providers/identity';
import type { TrafficSample } from '../src/services/providers';
import { recordTrafficSamples } from '../src/server/services/traffic-service';
import { enforceConfigStatuses } from '../src/server/services/status-service';
import { collectTunnelTraffic, collectXrayTraffic, getLastStatsError, syncXray, type SyncResult } from '../src/server/services/xray-service';
import { windowKeyFor } from './traffic-worker';
import { createLogger } from './lib/logger';
import { withLock } from './lib/lock';

/**
 * Xray reconcile worker.
 *
 * This is what makes the panel actually *manage* the proxy server. It runs on a
 * short interval and does three things:
 *
 *   1. Enforce — apply each configuration's own traffic ceiling. This has to
 *      happen here, on the fast tick, and not only in the (much slower)
 *      enforcement pass: a configuration that has reached its limit must stop
 *      serving promptly, otherwise it overshoots the allowance it was given.
 *
 *   2. Reconcile — render the node config from the database and apply it if it
 *      drifted. Creating, editing, disabling or deleting a configuration in the
 *      panel therefore takes effect within one interval, without anyone running
 *      a sync script by hand. A deleted configuration stops working, which is
 *      the behaviour an operator expects from "delete".
 *
 *   3. Account — read Xray's own per-user counters and write them to the ledger,
 *      so traffic figures are measured rather than simulated.
 *
 * Runs far more often than the traffic worker because config drift is what a
 * user notices immediately.
 */

const log = createLogger('xray-worker');

export interface XraySummary {
  enabled: boolean;
  changed: boolean;
  restarted: boolean;
  inbounds: number;
  ports: number[];
  samples: number;
  appliedBytes: string;
  skipped: string[];
  /** Configurations whose status flipped because they reached their ceiling. */
  ceilingsChanged: number;
  message: string;
  durationMs: number;
  skippedLock?: boolean;
}

/** Map Xray's per-client counters onto assignments and record them. */
async function collectAndRecord(): Promise<{ samples: number; appliedBytes: bigint }> {
  const samples = await collectXrayTraffic();

  // An empty list is ambiguous: it means either "no traffic since the last
  // pass" or "the stats query failed". The latter used to be invisible, which
  // is how accounting could stop without anyone noticing.
  const statsError = getLastStatsError();
  if (statsError) {
    log.warn('could not read node traffic counters', { error: statsError });
  }

  if (samples.length === 0) return { samples: 0, appliedBytes: 0n };

  // Resolve each client email back to the assignment that owns it.
  const assignmentIds = samples
    .map((sample) => assignmentIdFromEmail(sample.clientEmail))
    .filter((id): id is string => id !== null);

  if (assignmentIds.length === 0) return { samples: 0, appliedBytes: 0n };

  const assignments = await prisma.configAssignment.findMany({
    where: { id: { in: assignmentIds } },
    select: {
      id: true,
      userId: true,
      configId: true,
      config: { select: { serverId: true } },
    },
  });

  const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const windowKey = windowKeyFor();

  const resolved: TrafficSample[] = [];

  for (const sample of samples) {
    const assignmentId = assignmentIdFromEmail(sample.clientEmail);
    if (!assignmentId) continue;

    const assignment = byId.get(assignmentId);
    if (!assignment) {
      // The credential was revoked between collection and lookup — drop it.
      continue;
    }

    resolved.push({
      serverId: assignment.config.serverId,
      userId: assignment.userId,
      configId: assignment.configId,
      uploadBytes: sample.uploadBytes,
      downloadBytes: sample.downloadBytes,
      windowKey,
      source: 'AGENT',
      clientEmail: sample.clientEmail,
    });
  }

  if (resolved.length === 0) return { samples: 0, appliedBytes: 0n };

  const result = await recordTrafficSamples(resolved);
  return { samples: result.windows, appliedBytes: result.appliedBytes };
}

/** One reconcile + accounting pass. */
export async function runXrayReconcile(): Promise<XraySummary> {
  const started = Date.now();

  const outcome = await withLock('xray', 60, async (): Promise<Omit<XraySummary, 'durationMs'>> => {
    // Order matters. Collect first, then enforce, then reconcile:
    //
    //   - collecting before anything is torn down means the final bytes of a
    //     configuration that is about to be removed are still recorded;
    //   - enforcing against the figures just recorded lets the very same tick
    //     that notices an overshoot stop serving it. Enforcing first would
    //     delay the drop by a whole extra interval.
    let samples = 0;
    let appliedBytes = 0n;

    // Only read the node's counters when it is the accounting source.
    if (getEnv().NODE_PROVIDER === 'xray') {
      try {
        const collected = await collectAndRecord();
        samples = collected.samples;
        appliedBytes = collected.appliedBytes;
      } catch (error) {
        log.error('traffic accounting failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Tunnels have no users, so their counters never pass through the
      // assignment ledger. They are read from the same stats API and added to
      // the tunnel row directly.
      try {
        const tunnelTraffic = await collectTunnelTraffic();
        if (tunnelTraffic.updated > 0) {
          log.info('tunnel traffic recorded', {
            tunnels: tunnelTraffic.updated,
            bytes: tunnelTraffic.bytes.toString(),
          });
        }
      } catch (error) {
        log.error('tunnel traffic accounting failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Apply each configuration's OWN ceiling. This has to run on this fast tick
    // and not only in the (much slower) enforcement pass: a configuration on a
    // small allowance would otherwise blow well past its limit before anything
    // noticed.
    let ceilingsChanged = 0;
    try {
      const ceilings = await enforceConfigStatuses();
      ceilingsChanged = ceilings.changed;
      if (ceilingsChanged > 0) {
        log.info('configuration ceilings applied', { changed: ceilingsChanged });
      }
    } catch (error) {
      // Never let this block the reconcile: an unenforced ceiling is bad, a
      // node that stops being reconciled is worse.
      log.error('could not apply configuration ceilings', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const sync: SyncResult = await syncXray();

    if (sync.changed) {
      log.info('node config applied', {
        inbounds: sync.inbounds,
        ports: sync.ports,
        message: sync.message,
      });
    }

    return {
      enabled: sync.enabled,
      changed: sync.changed,
      restarted: sync.restarted,
      inbounds: sync.inbounds,
      ports: sync.ports,
      samples,
      appliedBytes: appliedBytes.toString(),
      skipped: sync.skipped,
      ceilingsChanged,
      message: sync.message,
    };
  });

  if (!outcome) {
    return {
      enabled: false,
      changed: false,
      restarted: false,
      inbounds: 0,
      ports: [],
      samples: 0,
      appliedBytes: '0',
      skipped: [],
      ceilingsChanged: 0,
      message: 'another pass is already running',
      durationMs: Date.now() - started,
      skippedLock: true,
    };
  }

  return { ...outcome, durationMs: Date.now() - started };
}

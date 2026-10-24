import { ConfigStatus } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { getEnv } from '../src/lib/env';
import { getProviders, type AttributionEntry, type TrafficSample } from '../src/services/providers';
import { toServerRef } from '../src/server/services/server-service';
import { recordTrafficSamples } from '../src/server/services/traffic-service';
import { getSettings } from '../src/server/services/settings-service';
import { createLogger } from './lib/logger';
import { withLock } from './lib/lock';

/**
 * Traffic collection worker.
 *
 * For every registered server it asks the traffic provider for usage deltas
 * since the last run, resolves each sample to a user/configuration, and writes
 * them to the `traffic_usage` ledger. Idempotency is guaranteed by the window
 * key, so a retry (or a duplicate replica that lost the lock race) is harmless.
 *
 * This worker is the ONLY writer of traffic data — the backend is the source of
 * truth, never the browser.
 */

const log = createLogger('traffic-worker');

/** Stable client identity written into node configs; resolved back to ids here. */
export const CLIENT_EMAIL_PREFIX = 'vp-';

export function clientEmailFor(assignmentId: string): string {
  return `${CLIENT_EMAIL_PREFIX}${assignmentId}`;
}

/** Round the clock to the minute — the collection window granularity. */
export function windowKeyFor(date = new Date()): string {
  return date.toISOString().slice(0, 16);
}

export interface TrafficCollectionSummary {
  servers: number;
  samples: number;
  appliedBytes: string;
  durationMs: number;
  skipped?: boolean;
}

/**
 * Map provider samples onto known assignments. A sample may arrive with ids
 * already resolved (local provider) or with only a client email (agent), in
 * which case we look the assignment up in the supplied attribution table.
 */
export function resolveAttribution(
  samples: TrafficSample[],
  attribution: AttributionEntry[],
): TrafficSample[] {
  const byEmail = new Map(attribution.map((entry) => [entry.clientEmail, entry]));

  return samples.map((sample) => {
    if (sample.userId && sample.configId) return sample;
    if (!sample.clientEmail) return sample;

    const entry = byEmail.get(sample.clientEmail);
    if (!entry) return sample;

    return { ...sample, userId: entry.userId, configId: entry.configId };
  });
}

async function collectForServer(
  server: Awaited<ReturnType<typeof prisma.server.findMany>>[number],
  windowKey: string,
  since: Date,
): Promise<{ samples: number; appliedBytes: bigint }> {
  const providers = getProviders();

  // Build the attribution table: which assignment (user + config) lives on this
  // server, and the client identity the node reports for it.
  const assignments = await prisma.configAssignment.findMany({
    where: { config: { serverId: server.id }, status: ConfigStatus.ACTIVE },
    select: { id: true, userId: true, configId: true },
  });

  const attribution: AttributionEntry[] = assignments.map((assignment) => ({
    assignmentId: assignment.id,
    userId: assignment.userId,
    configId: assignment.configId,
    clientEmail: clientEmailFor(assignment.id),
  }));

  const samples = await providers.traffic.collect(
    toServerRef(server),
    since,
    windowKey,
    { windowKey, attribution },
  );

  if (samples.length === 0) return { samples: 0, appliedBytes: 0n };

  const resolved = resolveAttribution(samples, attribution);
  const result = await recordTrafficSamples(resolved);

  return { samples: result.windows, appliedBytes: result.appliedBytes };
}

/** One full collection pass across every monitored server. */
export async function runTrafficCollection(): Promise<TrafficCollectionSummary> {
  return withLock('traffic', getEnv().WORKER_LOCK_TTL_SECONDS, async () => {
    const started = Date.now();

    // With NODE_PROVIDER=xray the counters come from the node itself and are
    // collected by the xray worker, which also knows how to reconcile config.
    // Running the provider path as well would double-count (or, worse, add the
    // simulated numbers on top of the real ones).
    if (getEnv().NODE_PROVIDER === 'xray') {
      log.info('traffic collection delegated to the xray worker');
      return {
        servers: 0,
        samples: 0,
        appliedBytes: '0',
        durationMs: Date.now() - started,
        skipped: true,
      };
    }

    const settings = await getSettings();
    const windowKey = windowKeyFor();
    const intervalSeconds =
      settings.general.monitoringIntervalSeconds || getEnv().TRAFFIC_INTERVAL_SECONDS;
    const since = new Date(Date.now() - intervalSeconds * 1000);

    const servers = await prisma.server.findMany({
      where: { monitoringEnabled: true, status: { not: 'DISABLED' } },
    });

    let samples = 0;
    let appliedBytes = 0n;
    let processed = 0;

    for (const server of servers) {
      try {
        const result = await collectForServer(server, windowKey, since);
        samples += result.samples;
        appliedBytes += result.appliedBytes;
        processed += 1;
      } catch (error) {
        log.error(`collection failed for server "${server.name}"`, {
          serverId: server.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await prisma.server
          .update({ where: { id: server.id }, data: { lastError: 'Traffic collection failed' } })
          .catch(() => undefined);
      }
    }

    const summary: TrafficCollectionSummary = {
      servers: processed,
      samples,
      appliedBytes: appliedBytes.toString(),
      durationMs: Date.now() - started,
    };

    log.info('traffic collection complete', { ...summary, windowKey });
    return summary;
  }).then((result) => result ?? { servers: 0, samples: 0, appliedBytes: '0', durationMs: 0, skipped: true });
}

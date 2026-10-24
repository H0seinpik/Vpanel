import { prisma } from '../src/lib/prisma';
import { getEnv } from '../src/lib/env';
import { refreshServerStatus } from '../src/server/services/server-service';
import { getSettings } from '../src/server/services/settings-service';
import { createLogger } from './lib/logger';
import { withLock } from './lib/lock';

/**
 * Monitoring worker.
 *
 * Polls each registered server's health through the provider layer, persists the
 * result (status, CPU, RAM, connections, heartbeat) and appends a metric sample
 * for the charts. It also prunes old samples so the table stays bounded.
 *
 * Only servers present in the `servers` table are ever contacted — there is no
 * scanning of arbitrary hosts.
 */

const log = createLogger('monitor-worker');

const METRIC_RETENTION_DAYS = 30;

export interface MonitorSummary {
  checked: number;
  online: number;
  offline: number;
  warning: number;
  pruned: number;
  durationMs: number;
  skipped?: boolean;
}

export async function runMonitoringPass(): Promise<MonitorSummary> {
  return withLock('monitor', getEnv().WORKER_LOCK_TTL_SECONDS, async () => {
    const started = Date.now();
    const settings = await getSettings();

    const servers = await prisma.server.findMany({
      where: { monitoringEnabled: true, status: { not: 'DISABLED' } },
      select: { id: true, name: true },
    });

    let online = 0;
    let offline = 0;
    let warning = 0;

    for (const server of servers) {
      try {
        const result = await refreshServerStatus(server.id);
        if (result.skipped) continue;
        if (result.status === 'ONLINE') online += 1;
        else if (result.status === 'WARNING') warning += 1;
        else offline += 1;
      } catch (error) {
        log.error(`health check failed for "${server.name}"`, {
          serverId: server.id,
          error: error instanceof Error ? error.message : String(error),
        });
        offline += 1;
      }
    }

    // Retention: drop metric samples older than the window.
    const cutoff = new Date(Date.now() - METRIC_RETENTION_DAYS * 86_400_000);
    const pruned = await prisma.serverMetric
      .deleteMany({ where: { sampledAt: { lt: cutoff } } })
      .then((r) => r.count)
      .catch(() => 0);

    const summary: MonitorSummary = {
      checked: servers.length,
      online,
      offline,
      warning,
      pruned,
      durationMs: Date.now() - started,
    };

    log.info('monitoring pass complete', {
      ...summary,
      heartbeatTimeoutSeconds: settings.server.heartbeatTimeoutSeconds,
    });
    return summary;
  }).then(
    (result) =>
      result ?? {
        checked: 0,
        online: 0,
        offline: 0,
        warning: 0,
        pruned: 0,
        durationMs: 0,
        skipped: true,
      },
  );
}

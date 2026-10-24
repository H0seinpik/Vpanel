import { getEnv } from '../src/lib/env';
import {
  enforceConfigStatuses,
  enforceUserStatuses,
  expireSubscriptions,
  resetMonthlyQuotas,
} from '../src/server/services/status-service';
import { triggerXraySync } from '../src/server/services/xray-service';
import { createLogger } from './lib/logger';
import { withLock } from './lib/lock';

/**
 * Enforcement worker.
 *
 * Re-derives every account's status from its traffic counters and expiry date,
 * applies each configuration's own traffic ceiling, expires lapsed
 * subscriptions, resets monthly quotas, and raises threshold notifications.
 * Runs less frequently than traffic collection — status changes only matter once
 * usage has been recorded.
 */

const log = createLogger('enforcement-worker');

export interface EnforcementSummary {
  usersChecked: number;
  statusesChanged: number;
  configurationsChecked: number;
  configurationsChanged: number;
  notificationsCreated: number;
  subscriptionsExpired: number;
  quotasReset: number;
  durationMs: number;
  skipped?: boolean;
}

export async function runEnforcementPass(): Promise<EnforcementSummary> {
  return withLock('enforcement', getEnv().WORKER_LOCK_TTL_SECONDS * 2, async () => {
    const started = Date.now();

    const enforcement = await enforceUserStatuses();

    // A configuration that hit its own ceiling must stop being served, so the
    // node config is re-applied immediately rather than waiting for the next
    // reconcile tick.
    const configs = await enforceConfigStatuses();
    if (configs.changed > 0) triggerXraySync();

    const subscriptionsExpired = await expireSubscriptions();
    const quotasReset = await resetMonthlyQuotas();

    const summary: EnforcementSummary = {
      usersChecked: enforcement.checked,
      statusesChanged: enforcement.changed,
      configurationsChecked: configs.checked,
      configurationsChanged: configs.changed,
      notificationsCreated: enforcement.notifications,
      subscriptionsExpired,
      quotasReset,
      durationMs: Date.now() - started,
    };

    log.info('enforcement pass complete', summary);
    return summary;
  }).then(
    (result) =>
      result ?? {
        usersChecked: 0,
        statusesChanged: 0,
        configurationsChecked: 0,
        configurationsChanged: 0,
        notificationsCreated: 0,
        subscriptionsExpired: 0,
        quotasReset: 0,
        durationMs: 0,
        skipped: true,
      },
  );
}

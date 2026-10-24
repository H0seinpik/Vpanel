import { ConfigStatus, UserRole, UserStatus, NotificationType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { percentOf } from '@/lib/utils';
import { recordAudit, AUDIT_ACTIONS } from '@/lib/audit';
import { createNotification, dispatchExternal } from './notification-service';
import { getSettings } from './settings-service';

/**
 * Status & quota enforcement.
 *
 * The backend is the source of truth for whether an account is usable. This
 * module evaluates the *derived* status of every account (expiry, traffic
 * ceiling) and raises threshold notifications. It is invoked by the background
 * worker on a schedule and can also be triggered on demand from the API.
 */

export interface EvaluatedStatus {
  status: UserStatus;
  reason: string | null;
}

export interface UserStatusInput {
  /** Optional so pure callers can omit it; staff exemption needs it. */
  role?: UserRole;
  status: UserStatus;
  expirationDate: Date | null;
  trafficUsedBytes: bigint;
  trafficLimitBytes: bigint | null;
}

/**
 * Derive the effective status.
 *
 * Precedence:
 *   1. manual DISABLED / SUSPENDED — an explicit decision is never auto-reverted
 *   2. staff exemption            — an ADMIN/OPERATOR is never quota- or
 *                                   expiry-locked (see below)
 *   3. EXPIRED
 *   4. TRAFFIC_EXCEEDED
 *   5. ACTIVE
 *
 * Order matters: the manual check comes FIRST so that disabling a staff account
 * still sticks. The staff exemption exists to stop automatic enforcement from
 * locking an administrator out of the panel they administer — not to override
 * a deliberate "disable this account".
 */
export function evaluateUserStatus(user: UserStatusInput, now = new Date()): EvaluatedStatus {
  if (user.status === UserStatus.DISABLED) {
    return { status: UserStatus.DISABLED, reason: 'Account disabled by an administrator.' };
  }
  if (user.status === UserStatus.SUSPENDED) {
    return { status: UserStatus.SUSPENDED, reason: 'Account suspended.' };
  }

  // Staff are not customers: a traffic ceiling or an expiry date must never
  // lock the person administering the system out of it. This also stops a quota
  // applied to a configuration from quietly expiring the admin's own account.
  if (user.role === UserRole.ADMIN || user.role === UserRole.OPERATOR) {
    return { status: UserStatus.ACTIVE, reason: null };
  }

  if (user.expirationDate && user.expirationDate.getTime() < now.getTime()) {
    return { status: UserStatus.EXPIRED, reason: 'Expiration date has passed.' };
  }

  if (
    user.trafficLimitBytes !== null &&
    user.trafficLimitBytes !== undefined &&
    user.trafficUsedBytes >= user.trafficLimitBytes
  ) {
    return { status: UserStatus.TRAFFIC_EXCEEDED, reason: 'Traffic limit reached.' };
  }

  return { status: UserStatus.ACTIVE, reason: null };
}

/** Is this account permitted to use its configuration right now? */
export function isUsable(status: UserStatus): boolean {
  return status === UserStatus.ACTIVE;
}

// -----------------------------------------------------------------------------
// Configuration-level enforcement
// -----------------------------------------------------------------------------

export interface ConfigEnforcementResult {
  checked: number;
  changed: number;
}

/**
 * Decide whether a configuration's status should change.
 *
 * Returns the next status, or null when nothing should happen. Pure so the rule
 * can be tested without a database — the transitions it governs are exactly the
 * ones an operator notices.
 *
 * Only ACTIVE ↔ TRAFFIC_EXCEEDED is managed. DISABLED and EXPIRED are deliberate
 * states and are left alone, on the same principle that protects a manually
 * disabled account.
 */
export function evaluateConfigStatus(config: {
  status: ConfigStatus;
  trafficUsedBytes: bigint;
  trafficLimitBytes: bigint | null;
}): ConfigStatus | null {
  if (config.status !== ConfigStatus.ACTIVE && config.status !== ConfigStatus.TRAFFIC_EXCEEDED) {
    return null;
  }

  // A limit that was removed should release a stopped configuration.
  if (config.trafficLimitBytes === null) {
    return config.status === ConfigStatus.TRAFFIC_EXCEEDED ? ConfigStatus.ACTIVE : null;
  }

  const exceeded = config.trafficUsedBytes >= config.trafficLimitBytes;
  const next = exceeded ? ConfigStatus.TRAFFIC_EXCEEDED : ConfigStatus.ACTIVE;

  return next === config.status ? null : next;
}

/**
 * Apply each configuration's OWN traffic ceiling.
 *
 * This is the rule that actually stops serving: reaching the configuration's
 * limit sets it to TRAFFIC_EXCEEDED, and the node supervisor only ever renders
 * ACTIVE configurations, so the inbound disappears.
 */
export async function enforceConfigStatuses(): Promise<ConfigEnforcementResult> {
  const configs = await prisma.configuration.findMany({
    where: { status: { in: [ConfigStatus.ACTIVE, ConfigStatus.TRAFFIC_EXCEEDED] } },
    select: {
      id: true,
      name: true,
      status: true,
      trafficLimitBytes: true,
      trafficUsedBytes: true,
      ownerId: true,
    },
  });

  let changed = 0;

  for (const config of configs) {
    const next = evaluateConfigStatus(config);
    if (next === null) continue;

    await prisma.configuration.update({ where: { id: config.id }, data: { status: next } });
    changed += 1;

    const exceeded = next === ConfigStatus.TRAFFIC_EXCEEDED;

    await recordAudit({
      action: AUDIT_ACTIONS.CONFIG_UPDATE,
      targetType: 'configuration',
      targetId: config.id,
      metadata: {
        from: config.status,
        to: next,
        reason: exceeded
          ? 'Configuration traffic limit reached'
          : 'Configuration back under its limit',
        usedBytes: config.trafficUsedBytes.toString(),
        limitBytes: config.trafficLimitBytes?.toString() ?? 'unlimited',
        actor: 'system:worker',
      },
    });

    if (config.ownerId) {
      await createNotification({
        userId: config.ownerId,
        type: exceeded ? NotificationType.TRAFFIC_EXCEEDED : NotificationType.SYSTEM,
        severity: exceeded ? 'CRITICAL' : 'INFO',
        title: exceeded ? 'Configuration stopped: traffic limit reached' : 'Configuration resumed',
        message: exceeded
          ? `"${config.name}" reached its traffic limit and has been stopped.`
          : `"${config.name}" is back under its traffic limit and is serving again.`,
        dedupeKey: `config-limit:${config.id}:${next}`,
      });
    }
  }

  return { checked: configs.length, changed };
}

function monthKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Threshold notifications. Uses dedupe keys scoped to the current month/day so
 * an alert fires once per cycle rather than on every worker run.
 */
export async function raiseThresholdNotifications(options: {
  warnPercent: number;
  criticalPercent: number;
  expiryWarningDays?: number;
}): Promise<number> {
  const { warnPercent, criticalPercent, expiryWarningDays = 7 } = options;
  const users = await prisma.user.findMany({
    where: { status: { in: [UserStatus.ACTIVE, UserStatus.TRAFFIC_EXCEEDED] } },
    select: {
      id: true,
      username: true,
      trafficUsedBytes: true,
      trafficLimitBytes: true,
      expirationDate: true,
    },
  });

  let created = 0;
  const now = new Date();

  for (const user of users) {
    // --- Traffic thresholds -------------------------------------------------
    if (user.trafficLimitBytes && user.trafficLimitBytes > 0n) {
      const percent = percentOf(user.trafficUsedBytes, user.trafficLimitBytes);
      const key = monthKey(now);

      if (percent >= 100) {
        const n = await createNotification({
          userId: user.id,
          type: NotificationType.TRAFFIC_EXCEEDED,
          severity: 'CRITICAL',
          title: 'Traffic limit reached',
          message: `Your data allowance has been fully consumed. Service is paused until it is renewed or reset.`,
          dedupeKey: `user:${user.id}:traffic:100:${key}`,
          metadata: { percent, userId: user.id },
        });
        if (n) created += 1;
      } else if (percent >= criticalPercent) {
        const n = await createNotification({
          userId: user.id,
          type: NotificationType.TRAFFIC_THRESHOLD,
          severity: 'CRITICAL',
          title: `Traffic at ${Math.round(percent)}%`,
          message: `You have used ${Math.round(percent)}% of your data allowance.`,
          dedupeKey: `user:${user.id}:traffic:${criticalPercent}:${key}`,
          metadata: { percent, userId: user.id },
        });
        if (n) created += 1;
      } else if (percent >= warnPercent) {
        const n = await createNotification({
          userId: user.id,
          type: NotificationType.TRAFFIC_THRESHOLD,
          severity: 'WARNING',
          title: `Traffic at ${Math.round(percent)}%`,
          message: `You have used ${Math.round(percent)}% of your data allowance.`,
          dedupeKey: `user:${user.id}:traffic:${warnPercent}:${key}`,
          metadata: { percent, userId: user.id },
        });
        if (n) created += 1;
      }
    }

    // --- Expiration warnings ------------------------------------------------
    if (user.expirationDate) {
      const daysLeft = Math.ceil((user.expirationDate.getTime() - now.getTime()) / 86_400_000);

      if (daysLeft < 0) {
        const n = await createNotification({
          userId: user.id,
          type: NotificationType.EXPIRED,
          severity: 'CRITICAL',
          title: 'Subscription expired',
          message: 'Your subscription has expired. Renew it to restore access.',
          dedupeKey: `user:${user.id}:expired:${dayKey(now)}`,
          metadata: { userId: user.id },
        });
        if (n) created += 1;
      } else if (daysLeft <= expiryWarningDays) {
        const n = await createNotification({
          userId: user.id,
          type: NotificationType.EXPIRATION_WARNING,
          severity: daysLeft <= 1 ? 'CRITICAL' : 'WARNING',
          title: daysLeft === 0 ? 'Subscription expires today' : `Subscription expires in ${daysLeft} day(s)`,
          message: `Your subscription ends on ${user.expirationDate.toISOString().slice(0, 10)}.`,
          dedupeKey: `user:${user.id}:expiry:${dayKey(now)}`,
          metadata: { daysLeft, userId: user.id },
        });
        if (n) created += 1;
      }
    }
  }

  return created;
}

export interface EnforcementResult {
  checked: number;
  changed: number;
  notifications: number;
}

/**
 * Full enforcement pass: re-derive every account's status, persist changes,
 * raise notifications, and (optionally) suspend accounts that exceeded quota.
 */
export async function enforceUserStatuses(): Promise<EnforcementResult> {
  const settings = await getSettings();
  const users = await prisma.user.findMany({
    select: {
      id: true,
      username: true,
      role: true,
      status: true,
      expirationDate: true,
      trafficUsedBytes: true,
      trafficLimitBytes: true,
    },
  });

  let changed = 0;
  const now = new Date();

  for (const user of users) {
    const evaluated = evaluateUserStatus(user, now);
    if (evaluated.status === user.status) continue;

    await prisma.user.update({
      where: { id: user.id },
      data: { status: evaluated.status },
    });
    changed += 1;

    await recordAudit({
      action: AUDIT_ACTIONS.QUOTA_ENFORCED,
      targetType: 'user',
      targetId: user.id,
      metadata: {
        from: user.status,
        to: evaluated.status,
        reason: evaluated.reason,
        actor: 'system:worker',
      },
    });

    if (evaluated.status === UserStatus.TRAFFIC_EXCEEDED || evaluated.status === UserStatus.EXPIRED) {
      await prisma.configAssignment.updateMany({
        where: { userId: user.id },
        data: { status: 'EXPIRED' },
      });
    } else if (evaluated.status === UserStatus.ACTIVE) {
      await prisma.configAssignment.updateMany({
        where: { userId: user.id, status: 'EXPIRED' },
        data: { status: 'ACTIVE' },
      });
    }
  }

  const notifications = await raiseThresholdNotifications({
    warnPercent: settings.general.trafficWarnPercent,
    criticalPercent: settings.general.trafficCriticalPercent,
  });

  await dispatchExternal({
    type: NotificationType.SYSTEM,
    title: 'Quota enforcement pass completed',
    message: `${changed} account(s) updated.`,
  }).catch(() => undefined);

  return { checked: users.length, changed, notifications };
}

/** Mark subscriptions whose end date has passed. */
export async function expireSubscriptions(): Promise<number> {
  const result = await prisma.subscription.updateMany({
    where: { status: 'ACTIVE', endsAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });
  return result.count;
}

/**
 * Reset monthly quotas for subscriptions whose reset date has arrived.
 * Returns the number of subscriptions reset.
 */
export async function resetMonthlyQuotas(): Promise<number> {
  const now = new Date();
  const due = await prisma.subscription.findMany({
    where: { status: 'ACTIVE', quotaType: 'MONTHLY', resetAt: { lte: now } },
    select: { id: true, userId: true },
  });

  for (const subscription of due) {
    const nextReset = new Date(now);
    nextReset.setMonth(nextReset.getMonth() + 1);

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { trafficUsedBytes: 0n, resetAt: nextReset },
    });
    await prisma.user.update({
      where: { id: subscription.userId },
      data: { trafficUsedBytes: 0n },
    });
  }

  return due.length;
}

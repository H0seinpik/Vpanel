import { prisma } from './prisma';

/**
 * Audit logging.
 *
 * Every security-relevant or state-changing action is recorded. Audit writes are
 * best-effort: a failure to log must never break the user's operation, but it is
 * surfaced to the server console so it can be alerted on.
 */

export const AUDIT_ACTIONS = {
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  TOKEN_REFRESH: 'auth.refresh',
  PASSWORD_RESET: 'auth.password_reset',

  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',
  USER_STATUS_CHANGE: 'user.status_change',
  USER_TRAFFIC_LIMIT_CHANGE: 'user.traffic_limit_change',
  USER_EXPIRATION_CHANGE: 'user.expiration_change',

  SERVER_CREATE: 'server.create',
  SERVER_UPDATE: 'server.update',
  SERVER_DELETE: 'server.delete',
  SERVER_TEST: 'server.test',
  SERVER_STATUS_CHANGE: 'server.status_change',

  CONFIG_CREATE: 'config.create',
  CONFIG_UPDATE: 'config.update',
  CONFIG_DELETE: 'config.delete',
  CONFIG_ASSIGN: 'config.assign',
  CONFIG_UNASSIGN: 'config.unassign',

  TUNNEL_CREATE: 'tunnel.create',
  TUNNEL_UPDATE: 'tunnel.update',
  TUNNEL_DELETE: 'tunnel.delete',

  INBOUND_CREATE: 'inbound.create',
  INBOUND_UPDATE: 'inbound.update',
  INBOUND_DELETE: 'inbound.delete',
  OUTBOUND_CREATE: 'outbound.create',
  OUTBOUND_UPDATE: 'outbound.update',
  OUTBOUND_DELETE: 'outbound.delete',
  ROUTING_CREATE: 'routing.create',
  ROUTING_UPDATE: 'routing.update',
  ROUTING_DELETE: 'routing.delete',
  REVERSE_PROXY_CREATE: 'reverse_proxy.create',
  REVERSE_PROXY_UPDATE: 'reverse_proxy.update',
  REVERSE_PROXY_DELETE: 'reverse_proxy.delete',

  PLAN_CREATE: 'plan.create',
  PLAN_UPDATE: 'plan.update',
  PLAN_DELETE: 'plan.delete',

  SUBSCRIPTION_CREATE: 'subscription.create',
  SUBSCRIPTION_UPDATE: 'subscription.update',

  DEVICE_REVOKE: 'device.revoke',

  SETTINGS_UPDATE: 'settings.update',
  SETTINGS_SECURITY_UPDATE: 'settings.security_update',

  QUOTA_ENFORCED: 'system.quota_enforced',
  WORKER_RUN: 'system.worker_run',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditInput {
  actorId?: string | null;
  actorName?: string | null;
  action: AuditAction | string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: (input.metadata ?? {}) as object,
      },
    });
  } catch (error) {
    console.error('[audit] failed to record audit entry', input.action, error);
  }
}

/** Convenience wrapper that pulls actor + IP/UA off a request context. */
export async function auditFromRequest(
  req: { headers: { get(name: string): string | null } },
  actor: { id: string; username: string } | null,
  action: AuditAction | string,
  options: {
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const forwarded = req.headers.get('x-forwarded-for');
  await recordAudit({
    actorId: actor?.id ?? null,
    actorName: actor?.username ?? null,
    action,
    targetType: options.targetType ?? null,
    targetId: options.targetId ?? null,
    ip: forwarded?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null,
    userAgent: req.headers.get('user-agent'),
    metadata: options.metadata,
  });
}

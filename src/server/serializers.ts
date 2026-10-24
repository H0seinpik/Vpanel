import type {
  AuditLog,
  ConfigAssignment,
  Configuration,
  Device,
  Notification,
  Plan,
  Server,
  Subscription,
  TrafficUsage,
  Tunnel,
  User,
} from '@prisma/client';

/**
 * Serializers.
 *
 * Prisma returns BigInt for byte counters and Date objects, neither of which is
 * JSON-safe. Every API response passes through these functions so:
 *   1. BigInt is converted to Number (byte values stay well inside 2^53).
 *   2. Dates become ISO strings.
 *   3. Secrets (`passwordHash`, `agentTokenCipher`) are stripped — they must
 *      never leave the server.
 */

const num = (value: bigint | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

// -----------------------------------------------------------------------------
// Users
// -----------------------------------------------------------------------------

export function serializeUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    status: user.status,
    notes: user.notes,
    planId: user.planId,
    trafficUsedBytes: num(user.trafficUsedBytes) ?? 0,
    trafficLimitBytes: num(user.trafficLimitBytes),
    expirationDate: iso(user.expirationDate),
    lastLoginAt: iso(user.lastLoginAt),
    lastSeenAt: iso(user.lastSeenAt),
    createdAt: iso(user.createdAt),
    updatedAt: iso(user.updatedAt),
  };
}

/**
 * Loose user projection used when embedding a user in another payload. `email`
 * is optional because not every query selects it.
 */
export type UserRefInput = Pick<User, 'id' | 'username' | 'displayName'> & {
  email?: string | null;
};

/** Minimal projection for embedding in other payloads. */
export function serializeUserRef(user: UserRefInput) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email ?? null,
  };
}

// -----------------------------------------------------------------------------
// Servers — credentials are NEVER serialised
// -----------------------------------------------------------------------------

export function serializeServer(server: Server) {
  return {
    id: server.id,
    name: server.name,
    hostname: server.hostname,
    ipAddress: server.ipAddress,
    port: server.port,
    protocol: server.protocol,
    type: server.type,
    location: server.location,
    status: server.status,
    description: server.description,
    monitoringEnabled: server.monitoringEnabled,
    // Whether an agent is configured is safe to expose; the token itself is not.
    hasAgent: Boolean(server.agentEndpoint),
    cpuPercent: server.cpuPercent,
    memPercent: server.memPercent,
    activeConnections: server.activeConnections ?? 0,
    activeUsers: server.activeUsers ?? 0,
    netInBytes: num(server.netInBytes) ?? 0,
    netOutBytes: num(server.netOutBytes) ?? 0,
    totalBandwidthBytes: num(server.totalBandwidthBytes) ?? 0,
    lastHeartbeat: iso(server.lastHeartbeat),
    lastError: server.lastError,
    createdAt: iso(server.createdAt),
    updatedAt: iso(server.updatedAt),
  };
}

/** Admin-only projection that reveals the agent endpoint (still not the token). */
export function serializeServerAdmin(server: Server) {
  return {
    ...serializeServer(server),
    agentEndpoint: server.agentEndpoint,
  };
}

// -----------------------------------------------------------------------------
// Tunnels — no credentials exist, so nothing needs redacting
// -----------------------------------------------------------------------------

export function serializeTunnel(
  tunnel: Tunnel & {
    server?: Pick<Server, 'id' | 'name' | 'hostname' | 'status'> | null;
  },
) {
  return {
    id: tunnel.id,
    name: tunnel.name,
    serverId: tunnel.serverId,
    listenAddress: tunnel.listenAddress,
    listenPort: tunnel.listenPort,
    targetHost: tunnel.targetHost,
    targetPort: tunnel.targetPort,
    network: tunnel.network,
    enabled: tunnel.enabled,
    notes: tunnel.notes,
    lastError: tunnel.lastError,
    trafficUpBytes: num(tunnel.trafficUpBytes) ?? 0,
    trafficDownBytes: num(tunnel.trafficDownBytes) ?? 0,
    trafficTotalBytes: Number(tunnel.trafficUpBytes + tunnel.trafficDownBytes),
    server: tunnel.server
      ? {
          id: tunnel.server.id,
          name: tunnel.server.name,
          hostname: tunnel.server.hostname,
          status: tunnel.server.status,
        }
      : undefined,
    createdAt: iso(tunnel.createdAt),
    updatedAt: iso(tunnel.updatedAt),
  };
}

// -----------------------------------------------------------------------------
// Configurations
// -----------------------------------------------------------------------------

export function serializeConfig(
  config: Configuration & {
    server?: Pick<Server, 'id' | 'name' | 'hostname' | 'location' | 'status'> | null;
    owner?: UserRefInput | null;
    protocol?: { id: string; type: string; name: string } | null;
    _count?: { assignments: number };
    /** Aggregate usage across the configuration's assignments, when loaded. */
    trafficUsedBytes?: bigint;
  },
  options: { includeShareLink?: boolean } = {},
) {
  return {
    id: config.id,
    name: config.name,
    serverId: config.serverId,
    protocolId: config.protocolId,
    type: config.type,
    status: config.status,
    ownerId: config.ownerId,
    params: config.params,
    remarks: config.remarks,
    // The share link contains a credential, so it is only included on request
    // and only for callers allowed to see that credential.
    ...(options.includeShareLink ? { shareLink: config.shareLink } : {}),
    server: config.server
      ? {
          id: config.server.id,
          name: config.server.name,
          hostname: config.server.hostname,
          location: config.server.location,
          status: config.server.status,
        }
      : undefined,
    owner: config.owner ? serializeUserRef(config.owner) : null,
    protocol: config.protocol ? { id: config.protocol.id, type: config.protocol.type } : undefined,
      assignmentCount: config._count?.assignments,
      /** The configuration's own ceiling (null = unlimited). */
      trafficLimitBytes: num(config.trafficLimitBytes),
      /** Total across every assignment. */
      trafficUsedBytes: num(config.trafficUsedBytes ?? 0n) ?? 0,
      createdAt: iso(config.createdAt),
      updatedAt: iso(config.updatedAt),
    };
  }

export function serializeAssignment(
  assignment: ConfigAssignment & {
    user?: UserRefInput | null;
  },
  options: { includeShareLink?: boolean } = {},
) {
  return {
    id: assignment.id,
    configId: assignment.configId,
    userId: assignment.userId,
    status: assignment.status,
    trafficUsedBytes: num(assignment.trafficUsedBytes) ?? 0,
    ...(options.includeShareLink ? { shareLink: assignment.shareLink } : {}),
    user: assignment.user ? serializeUserRef(assignment.user) : undefined,
    createdAt: iso(assignment.createdAt),
    updatedAt: iso(assignment.updatedAt),
  };
}

// -----------------------------------------------------------------------------
// Plans / subscriptions / devices
// -----------------------------------------------------------------------------

export function serializePlan(plan: Plan) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    priceCents: plan.priceCents,
    currency: plan.currency,
    trafficLimitBytes: num(plan.trafficLimitBytes),
    durationDays: plan.durationDays,
    deviceLimit: plan.deviceLimit,
    allowedProtocols: plan.allowedProtocols,
    allowedServerIds: plan.allowedServerIds,
    status: plan.status,
    isDefault: plan.isDefault,
    createdAt: iso(plan.createdAt),
    updatedAt: iso(plan.updatedAt),
  };
}

export function serializeSubscription(
  subscription: Subscription & {
    plan?: Pick<Plan, 'id' | 'name'> | null;
    server?: Pick<Server, 'id' | 'name'> | null;
    user?: UserRefInput | null;
  },
) {
  return {
    id: subscription.id,
    userId: subscription.userId,
    planId: subscription.planId,
    serverId: subscription.serverId,
    quotaType: subscription.quotaType,
    trafficLimitBytes: num(subscription.trafficLimitBytes),
    trafficUsedBytes: num(subscription.trafficUsedBytes) ?? 0,
    startsAt: iso(subscription.startsAt),
    endsAt: iso(subscription.endsAt),
    resetAt: iso(subscription.resetAt),
    status: subscription.status,
    plan: subscription.plan ? { id: subscription.plan.id, name: subscription.plan.name } : null,
    server: subscription.server
      ? { id: subscription.server.id, name: subscription.server.name }
      : null,
    user: subscription.user ? serializeUserRef(subscription.user) : undefined,
    createdAt: iso(subscription.createdAt),
    updatedAt: iso(subscription.updatedAt),
  };
}

export function serializeDevice(device: Device) {
  return {
    id: device.id,
    userId: device.userId,
    name: device.name,
    platform: device.platform,
    status: device.status,
    deviceKey: device.deviceKey,
    userAgent: device.userAgent,
    lastIp: device.lastIp,
    lastSeenAt: iso(device.lastSeenAt),
    createdAt: iso(device.createdAt),
    updatedAt: iso(device.updatedAt),
  };
}

// -----------------------------------------------------------------------------
// Traffic / audit / notifications
// -----------------------------------------------------------------------------

export function serializeTrafficUsage(
  usage: TrafficUsage & {
    user?: Pick<User, 'id' | 'username' | 'displayName'> | null;
    server?: Pick<Server, 'id' | 'name'> | null;
    config?: Pick<Configuration, 'id' | 'name'> | null;
  },
) {
  return {
    id: usage.id,
    userId: usage.userId,
    serverId: usage.serverId,
    configId: usage.configId,
    uploadBytes: num(usage.uploadBytes) ?? 0,
    downloadBytes: num(usage.downloadBytes) ?? 0,
    totalBytes: num(usage.totalBytes) ?? 0,
    source: usage.source,
    timestamp: iso(usage.timestamp),
    user: usage.user ? serializeUserRef(usage.user) : null,
    server: usage.server ? { id: usage.server.id, name: usage.server.name } : null,
    config: usage.config ? { id: usage.config.id, name: usage.config.name } : null,
  };
}

export function serializeAuditLog(
  log: AuditLog & { actor?: Pick<User, 'id' | 'username' | 'displayName'> | null },
) {
  return {
    id: log.id,
    actorId: log.actorId,
    actorName: log.actorName ?? log.actor?.username ?? null,
    action: log.action,
    targetType: log.targetType,
    targetId: log.targetId,
    ip: log.ip,
    userAgent: log.userAgent,
    metadata: log.metadata,
    createdAt: iso(log.createdAt),
  };
}

export function serializeNotification(notification: Notification) {
  return {
    id: notification.id,
    userId: notification.userId,
    type: notification.type,
    severity: notification.severity,
    title: notification.title,
    message: notification.message,
    isRead: notification.isRead,
    readAt: iso(notification.readAt),
    metadata: notification.metadata,
    createdAt: iso(notification.createdAt),
  };
}

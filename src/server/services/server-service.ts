import { Prisma, ServerStatus, ServerType, NotificationType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ConflictError, NotFoundError, ProviderError } from '@/lib/api/errors';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';
import { getProviders, type ServerRef } from '@/services/providers';
import { createNotification } from './notification-service';
import type { ActorContext } from './user-service';

/**
 * Server management.
 *
 * Only servers an administrator has registered here are ever contacted. The
 * provider layer receives a `ServerRef` and can do nothing else. Agent
 * credentials are encrypted at rest and are never returned to the frontend.
 */

export interface ListServersQuery {
  search?: string;
  status?: ServerStatus;
  type?: ServerType;
  location?: string;
  sort?: 'createdAt' | 'name' | 'status' | 'lastHeartbeat';
  order?: 'asc' | 'desc';
}

export async function listServers(
  query: ListServersQuery,
  pagination: { skip: number; take: number },
) {
  const where: Prisma.ServerWhereInput = {};

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { hostname: { contains: query.search, mode: 'insensitive' } },
      { ipAddress: { contains: query.search, mode: 'insensitive' } },
      { location: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  if (query.status) where.status = query.status;
  if (query.type) where.type = query.type;
  if (query.location) where.location = { contains: query.location, mode: 'insensitive' };

  const [items, total] = await Promise.all([
    prisma.server.findMany({
      where,
      orderBy: { [query.sort ?? 'createdAt']: query.order ?? 'desc' },
      skip: pagination.skip,
      take: pagination.take,
      include: {
        _count: { select: { configs: true } },
      },
    }),
    prisma.server.count({ where }),
  ]);

  return { items, total };
}

export async function getServerById(id: string) {
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) throw new NotFoundError('Server');
  return server;
}

export async function getServerDetail(id: string) {
  const server = await prisma.server.findUnique({
    where: { id },
    include: {
      configs: {
        orderBy: { createdAt: 'desc' },
        include: {
          owner: { select: { id: true, username: true, displayName: true } },
          _count: { select: { assignments: true } },
        },
      },
      metrics: { orderBy: { sampledAt: 'desc' }, take: 60 },
      _count: { select: { configs: true, trafficUsage: true } },
    },
  });
  if (!server) throw new NotFoundError('Server');
  return server;
}

/** Recent metric samples for the monitoring charts. */
export async function getServerMetrics(serverId: string, take = 60) {
  return prisma.serverMetric.findMany({
    where: { serverId },
    orderBy: { sampledAt: 'desc' },
    take,
  });
}

/** Build the provider-facing projection, decrypting the agent token on demand. */
export function toServerRef(server: {
  id: string;
  name: string;
  hostname: string;
  ipAddress: string;
  port: number;
  type: string;
  agentEndpoint: string | null;
  agentTokenCipher: string | null;
}): ServerRef {
  let agentToken: string | null = null;
  if (server.agentTokenCipher) {
    try {
      agentToken = decryptSecret(server.agentTokenCipher);
    } catch {
      agentToken = null; // treat a corrupt token as "no token configured"
    }
  }

  return {
    id: server.id,
    name: server.name,
    hostname: server.hostname,
    ipAddress: server.ipAddress,
    port: server.port,
    type: server.type,
    agentEndpoint: server.agentEndpoint,
    agentToken,
  };
}

export interface CreateServerInput {
  name: string;
  hostname: string;
  ipAddress: string;
  port?: number;
  protocol?: Prisma.ServerCreateInput['protocol'];
  type?: ServerType;
  location?: string;
  description?: string;
  monitoringEnabled?: boolean;
  agentEndpoint?: string;
  agentToken?: string;
}

export async function createServer(input: CreateServerInput, actor: ActorContext) {
  const duplicate = await prisma.server.findFirst({
    where: { hostname: input.hostname, port: input.port ?? 443 },
  });
  if (duplicate) {
    throw new ConflictError('A server with that hostname and port already exists.');
  }

  const server = await prisma.server.create({
    data: {
      name: input.name,
      hostname: input.hostname,
      ipAddress: input.ipAddress,
      port: input.port ?? 443,
      protocol: input.protocol ?? 'VLESS',
      type: input.type ?? ServerType.XRAY,
      location: input.location ?? null,
      description: input.description ?? null,
      monitoringEnabled: input.monitoringEnabled ?? true,
      agentEndpoint: input.agentEndpoint || null,
      // Encrypted at rest; never serialised back to the client.
      agentTokenCipher: input.agentToken ? encryptSecret(input.agentToken) : null,
      status: ServerStatus.PENDING,
    },
  });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.SERVER_CREATE,
    targetType: 'server',
    targetId: server.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { name: server.name, hostname: server.hostname, type: server.type },
  });

  return server;
}

export interface UpdateServerInput extends Partial<CreateServerInput> {
  status?: ServerStatus;
}

export async function updateServer(id: string, input: UpdateServerInput, actor: ActorContext) {
  const current = await prisma.server.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Server');

  const data: Prisma.ServerUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.hostname !== undefined) data.hostname = input.hostname;
  if (input.ipAddress !== undefined) data.ipAddress = input.ipAddress;
  if (input.port !== undefined) data.port = input.port;
  if (input.protocol !== undefined) data.protocol = input.protocol;
  if (input.type !== undefined) data.type = input.type;
  if (input.location !== undefined) data.location = input.location;
  if (input.description !== undefined) data.description = input.description;
  if (input.monitoringEnabled !== undefined) data.monitoringEnabled = input.monitoringEnabled;
  if (input.status !== undefined) data.status = input.status;
  if (input.agentEndpoint !== undefined) data.agentEndpoint = input.agentEndpoint || null;
  if (input.agentToken) data.agentTokenCipher = encryptSecret(input.agentToken);

  const updated = await prisma.server.update({ where: { id }, data });

  if (input.status !== undefined && input.status !== current.status) {
    await recordAudit({
      actorId: actor.id,
      actorName: actor.username,
      action: AUDIT_ACTIONS.SERVER_STATUS_CHANGE,
      targetType: 'server',
      targetId: id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { from: current.status, to: input.status },
    });
  }

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.SERVER_UPDATE,
    targetType: 'server',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    // Never log credentials — only which fields changed.
    metadata: { fields: Object.keys(input).filter((k) => k !== 'agentToken') },
  });

  return updated;
}

export async function deleteServer(id: string, actor: ActorContext) {
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) throw new NotFoundError('Server');

  await prisma.server.delete({ where: { id } });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.SERVER_DELETE,
    targetType: 'server',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { name: server.name, hostname: server.hostname },
  });

  return { id };
}

/** Probe reachability of a registered server. Never scans beyond this host. */
export async function testServerConnection(id: string, actor: ActorContext) {
  const server = await getServerById(id);
  const providers = getProviders();
  const result = await providers.node.testConnection(toServerRef(server));

  await prisma.server.update({
    where: { id },
    data: {
      lastError: result.ok ? null : result.message,
      ...(result.ok && server.status === ServerStatus.PENDING
        ? { status: ServerStatus.ONLINE, lastHeartbeat: new Date() }
        : {}),
    },
  });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.SERVER_TEST,
    targetType: 'server',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { ok: result.ok, latencyMs: result.latencyMs ?? null },
  });

  if (!result.ok && !result.message) {
    throw new ProviderError('Connection test failed with no diagnostic message.');
  }

  return result;
}

/**
 * Refresh a server's live status: pull metrics, persist them, write a metric
 * sample, and raise online/offline notifications with dedupe keys.
 */
export async function refreshServerStatus(id: string) {
  const server = await getServerById(id);

  if (!server.monitoringEnabled) {
    return { skipped: true, reason: 'Monitoring disabled for this server.' };
  }

  const providers = getProviders();
  const health = await providers.server.checkHealth(toServerRef(server));

  await prisma.server.update({
    where: { id },
    data: {
      status: health.status,
      cpuPercent: health.metrics?.cpuPercent ?? null,
      memPercent: health.metrics?.memPercent ?? null,
      activeConnections: health.metrics?.activeConnections ?? 0,
      activeUsers: health.metrics?.activeUsers ?? 0,
      netInBytes: health.metrics?.netInBytes ?? server.netInBytes,
      netOutBytes: health.metrics?.netOutBytes ?? server.netOutBytes,
      lastHeartbeat: health.lastHeartbeat ?? server.lastHeartbeat,
      lastError: health.error ?? null,
    },
  });

  if (health.metrics) {
    await prisma.serverMetric.create({
      data: {
        serverId: id,
        cpuPercent: health.metrics.cpuPercent ?? null,
        memPercent: health.metrics.memPercent ?? null,
        activeConnections: health.metrics.activeConnections ?? 0,
        activeUsers: health.metrics.activeUsers ?? 0,
        netInBytes: health.metrics.netInBytes ?? 0n,
        netOutBytes: health.metrics.netOutBytes ?? 0n,
      },
    });
  }

  // --- Notifications on state transitions ----------------------------------
  const wasOnline = server.status === ServerStatus.ONLINE || server.status === ServerStatus.WARNING;
  const isOnline = health.status === ServerStatus.ONLINE || health.status === ServerStatus.WARNING;

  if (wasOnline && !isOnline) {
    await createNotification({
      type: NotificationType.SERVER_OFFLINE,
      severity: 'CRITICAL',
      title: `Server offline: ${server.name}`,
      message: health.error ?? 'The server stopped responding to heartbeats.',
      dedupeKey: `server:${id}:offline:${new Date().toISOString().slice(0, 13)}`,
      metadata: { serverId: id, status: health.status },
    });
  } else if (!wasOnline && isOnline && server.status !== ServerStatus.PENDING) {
    await createNotification({
      type: NotificationType.SERVER_ONLINE,
      severity: 'INFO',
      title: `Server back online: ${server.name}`,
      message: 'The server is responding to heartbeats again.',
      dedupeKey: `server:${id}:online:${new Date().toISOString().slice(0, 13)}`,
      metadata: { serverId: id },
    });
  }

  return { skipped: false, status: health.status, metrics: health.metrics, error: health.error };
}

/** Counters for the servers list header. */
export async function getServerCounters() {
  const [total, online, offline, warning, disabled] = await Promise.all([
    prisma.server.count(),
    prisma.server.count({ where: { status: ServerStatus.ONLINE } }),
    prisma.server.count({ where: { status: ServerStatus.OFFLINE } }),
    prisma.server.count({ where: { status: ServerStatus.WARNING } }),
    prisma.server.count({ where: { status: ServerStatus.DISABLED } }),
  ]);
  return { total, online, offline, warning, disabled };
}

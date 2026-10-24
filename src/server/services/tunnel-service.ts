import { ConfigStatus, Prisma, TunnelNetwork } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';
import { getEnv } from '@/lib/env';
import { staticPortConflict } from '@/services/port-conflicts';
import { triggerXraySync } from './xray-service';
import type { ActorContext } from './user-service';

/**
 * Tunnel management.
 *
 * A tunnel is Xray's credential-less port forwarder: every byte arriving on
 * `listenPort` is handed to `targetHost:targetPort`. There are no users, no
 * share links and no per-user counters, which is exactly why it is a separate
 * service and table rather than a fifth `ProtocolType`.
 *
 * The important invariant is the same one configurations already live by: Xray
 * aborts the ENTIRE process when one inbound cannot bind, so a tunnel must never
 * be allowed to claim a port that another inbound already owns.
 */

export interface ListTunnelsQuery {
  search?: string;
  serverId?: string;
  network?: TunnelNetwork;
  enabled?: boolean;
  sort?: 'createdAt' | 'name' | 'listenPort' | 'trafficUpBytes';
  order?: 'asc' | 'desc';
}

export interface CreateTunnelInput {
  name: string;
  serverId: string;
  listenAddress?: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  network?: TunnelNetwork;
  enabled?: boolean;
  notes?: string;
}

export interface UpdateTunnelInput {
  name?: string;
  serverId?: string;
  listenAddress?: string;
  listenPort?: number;
  targetHost?: string;
  targetPort?: number;
  network?: TunnelNetwork;
  enabled?: boolean;
  notes?: string | null;
}

const serverSelect = {
  select: { id: true, name: true, hostname: true, status: true },
} as const;

export async function listTunnels(
  query: ListTunnelsQuery,
  pagination: { skip: number; take: number },
) {
  const where: Prisma.TunnelWhereInput = {};

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { targetHost: { contains: query.search, mode: 'insensitive' } },
      { notes: { contains: query.search, mode: 'insensitive' } },
      { server: { name: { contains: query.search, mode: 'insensitive' } } },
    ];
  }
  if (query.serverId) where.serverId = query.serverId;
  if (query.network) where.network = query.network;
  if (query.enabled !== undefined) where.enabled = query.enabled;

  const [items, total] = await Promise.all([
    prisma.tunnel.findMany({
      where,
      orderBy: { [query.sort ?? 'createdAt']: query.order ?? 'desc' },
      skip: pagination.skip,
      take: pagination.take,
      include: { server: serverSelect },
    }),
    prisma.tunnel.count({ where }),
  ]);

  return { items, total };
}

export async function getTunnel(id: string) {
  const tunnel = await prisma.tunnel.findUnique({
    where: { id },
    include: { server: serverSelect },
  });
  if (!tunnel) throw new NotFoundError('Tunnel');
  return tunnel;
}

/**
 * Reject a listen port that cannot be served.
 *
 * Checks are deliberately global rather than per-server: VPanel's supervisor
 * renders every row into ONE local Xray config, so two rows on different
 * "servers" would still fight over the same socket on this machine.
 */
async function assertTunnelPortAvailable(input: {
  listenPort: number;
  /** Ignore this row — used when updating an existing tunnel. */
  excludeId?: string;
}): Promise<void> {
  const port = input.listenPort;

  const reserved = staticPortConflict(port);
  if (reserved) {
    throw new ValidationError(
      `Port ${port} ${reserved.reason}. ${reserved.fix}. ` +
        'Xray refuses to start at all when one inbound cannot bind, so this would also ' +
        'stop every configuration on this machine from working.',
    );
  }

  if (port === getEnv().XRAY_API_PORT) {
    throw new ValidationError(
      `Port ${port} is the panel's own Xray stats API. Pick a different port.`,
    );
  }

  const otherTunnel = await prisma.tunnel.findFirst({
    where: {
      listenPort: port,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    },
    select: { name: true },
  });
  if (otherTunnel) {
    throw new ConflictError(
      `Port ${port} is already used by tunnel "${otherTunnel.name}". ` +
        'Give this tunnel a different port, or edit the existing tunnel.',
    );
  }

  // Only ACTIVE configurations contend for a port. A disabled one can be
  // enabled later, and that activation path performs this same check.
  const configs = await prisma.configuration.findMany({
    where: { status: ConfigStatus.ACTIVE },
    select: {
      name: true,
      params: true,
      server: { select: { port: true } },
    },
  });

  const occupant = configs.find((config) => {
    const params = (config.params ?? {}) as Record<string, unknown>;
    return Number(params.port ?? config.server.port) === port;
  });

  if (occupant) {
    throw new ConflictError(
      `Port ${port} is already used by configuration "${occupant.name}". ` +
        'A tunnel cannot share a port with a configuration — give the tunnel its own port.',
    );
  }
}

export async function createTunnel(input: CreateTunnelInput, actor: ActorContext) {
  const server = await prisma.server.findUnique({ where: { id: input.serverId } });
  if (!server) throw new NotFoundError('Server');

  const enabled = input.enabled ?? true;
  if (enabled) {
    await assertTunnelPortAvailable({ listenPort: input.listenPort });
  }

  let tunnel;
  try {
    tunnel = await prisma.tunnel.create({
      data: {
        name: input.name,
        serverId: input.serverId,
        listenAddress: input.listenAddress || '0.0.0.0',
        listenPort: input.listenPort,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
        network: input.network ?? TunnelNetwork.TCP,
        enabled,
        notes: input.notes ?? null,
        createdById: actor.id,
      },
      include: { server: serverSelect },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new ConflictError(
        `Port ${input.listenPort} is already used by another tunnel on this server.`,
      );
    }
    throw error;
  }

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.TUNNEL_CREATE,
    targetType: 'tunnel',
    targetId: tunnel.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: {
      name: tunnel.name,
      listenPort: tunnel.listenPort,
      target: `${tunnel.targetHost}:${tunnel.targetPort}`,
      network: tunnel.network,
    },
  });

  triggerXraySync();
  return tunnel;
}

export async function updateTunnel(id: string, input: UpdateTunnelInput, actor: ActorContext) {
  const current = await prisma.tunnel.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Tunnel');

  if (input.serverId && input.serverId !== current.serverId) {
    const server = await prisma.server.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundError('Server');
  }

  const next = {
    serverId: input.serverId ?? current.serverId,
    listenPort: input.listenPort ?? current.listenPort,
    enabled: input.enabled ?? current.enabled,
  };

  // Disabling is always allowed, even if the port has since been taken. Only a
  // row that will actually be rendered has to pass the port checks, and only
  // when the change can affect which socket it claims. Editing a note on an
  // already-enabled tunnel must not fail just because a third party grabbed the
  // port in the meantime — the row is already broken and `lastError` says so.
  const portChanged = input.listenPort !== undefined && input.listenPort !== current.listenPort;
  const serverChanged = input.serverId !== undefined && input.serverId !== current.serverId;
  const enabling = input.enabled === true && !current.enabled;

  if (next.enabled && (portChanged || serverChanged || enabling)) {
    await assertTunnelPortAvailable({ listenPort: next.listenPort, excludeId: id });
  }

  const data: Prisma.TunnelUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.serverId !== undefined) data.server = { connect: { id: input.serverId } };
  if (input.listenAddress !== undefined) data.listenAddress = input.listenAddress || '0.0.0.0';
  if (input.listenPort !== undefined) data.listenPort = input.listenPort;
  if (input.targetHost !== undefined) data.targetHost = input.targetHost;
  if (input.targetPort !== undefined) data.targetPort = input.targetPort;
  if (input.network !== undefined) data.network = input.network;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.notes !== undefined) data.notes = input.notes;

  let updated;
  try {
    updated = await prisma.tunnel.update({
      where: { id },
      data,
      include: { server: serverSelect },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new ConflictError(
        `Port ${next.listenPort} is already used by another tunnel on this server.`,
      );
    }
    throw error;
  }

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.TUNNEL_UPDATE,
    targetType: 'tunnel',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { fields: Object.keys(input) },
  });

  triggerXraySync();
  return updated;
}

export async function deleteTunnel(id: string, actor: ActorContext) {
  const tunnel = await prisma.tunnel.findUnique({ where: { id } });
  if (!tunnel) throw new NotFoundError('Tunnel');

  await prisma.tunnel.delete({ where: { id } });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.TUNNEL_DELETE,
    targetType: 'tunnel',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: {
      name: tunnel.name,
      listenPort: tunnel.listenPort,
      target: `${tunnel.targetHost}:${tunnel.targetPort}`,
    },
  });

  triggerXraySync();
  return { id };
}

/** Counters for the tunnels list header. */
export async function getTunnelCounters() {
  const [total, enabled, aggregate] = await Promise.all([
    prisma.tunnel.count(),
    prisma.tunnel.count({ where: { enabled: true } }),
    prisma.tunnel.aggregate({
      _sum: { trafficUpBytes: true, trafficDownBytes: true },
    }),
  ]);

  const up = aggregate._sum.trafficUpBytes ?? 0n;
  const down = aggregate._sum.trafficDownBytes ?? 0n;

  return {
    total,
    enabled,
    disabled: total - enabled,
    trafficUpBytes: Number(up),
    trafficDownBytes: Number(down),
    trafficTotalBytes: Number(up + down),
  };
}

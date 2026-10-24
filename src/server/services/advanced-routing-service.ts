import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';
import { getEnv } from '@/lib/env';
import { staticPortConflict } from '@/services/port-conflicts';
import { triggerXraySync } from './xray-service';
import type { ActorContext } from './user-service';

/**
 * CRUD for the advanced Xray objects (Phase 3).
 *
 * Every mutation ends with `triggerXraySync()`, so the node picks the change up
 * on the next reconcile exactly like a configuration edit does. The invariant
 * that matters is the one configurations and tunnels already live by: Xray
 * aborts the WHOLE process when one inbound cannot bind or two inbounds share a
 * tag, so a row that cannot be served must be rejected here rather than allowed
 * to reach the node.
 */

export interface AdvancedListQuery {
  search?: string;
  serverId?: string;
  enabled?: boolean;
  role?: 'BRIDGE' | 'PORTAL';
  sort?: string;
  order?: 'asc' | 'desc';
}

const serverSelect = {
  select: { id: true, name: true, hostname: true, status: true },
} as const;

async function assertServer(serverId: string): Promise<void> {
  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
  if (!server) throw new NotFoundError('Server');
}

async function record(
  actor: ActorContext,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action,
    targetType,
    targetId,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === 'P2002';
}

// -----------------------------------------------------------------------------
// Inbounds
// -----------------------------------------------------------------------------

export interface CreateInboundInput {
  name: string;
  serverId: string;
  tag: string;
  protocol?: string;
  listen?: string;
  port: number;
  settings?: Record<string, unknown>;
  streamSettings?: Record<string, unknown>;
  sniffing?: Record<string, unknown>;
  enabled?: boolean;
  sortOrder?: number;
  remarks?: string;
}

export type UpdateInboundInput = Partial<CreateInboundInput>;

/**
 * Reject a listen port that cannot be served.
 *
 * Global, not per-server: the supervisor renders every row into ONE local
 * `config.json`, so two rows on different "servers" would still fight over the
 * same socket on this machine.
 */
async function assertInboundPortAvailable(input: {
  port: number;
  excludeId?: string;
}): Promise<void> {
  const port = input.port;

  const reserved = staticPortConflict(port);
  if (reserved) {
    throw new ValidationError(
      `Port ${port} ${reserved.reason}. ${reserved.fix}. Xray refuses to start at all ` +
        'when one inbound cannot bind, so this would also stop every other configuration.',
    );
  }
  if (port === getEnv().XRAY_API_PORT) {
    throw new ValidationError(`Port ${port} is the panel's own Xray stats API. Pick another port.`);
  }

  const [otherInbound, tunnel] = await Promise.all([
    prisma.inbound.findFirst({
      where: { port, ...(input.excludeId ? { id: { not: input.excludeId } } : {}) },
      select: { name: true },
    }),
    prisma.tunnel.findFirst({ where: { listenPort: port }, select: { name: true } }),
  ]);

  if (otherInbound) {
    throw new ConflictError(`Port ${port} is already used by inbound "${otherInbound.name}".`);
  }
  if (tunnel) {
    throw new ConflictError(`Port ${port} is already used by tunnel "${tunnel.name}".`);
  }

  const configs = await prisma.configuration.findMany({
    where: { status: 'ACTIVE' },
    select: { name: true, params: true, server: { select: { port: true } } },
  });
  const occupant = configs.find((config) => {
    const params = (config.params ?? {}) as Record<string, unknown>;
    return Number(params.port ?? config.server.port) === port;
  });
  if (occupant) {
    throw new ConflictError(`Port ${port} is already used by configuration "${occupant.name}".`);
  }
}

async function assertInboundTagFree(
  serverId: string,
  tag: string,
  excludeId?: string,
): Promise<void> {
  const existing = await prisma.inbound.findFirst({
    where: { serverId, tag, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { name: true },
  });
  if (existing) {
    throw new ConflictError(
      `Tag "${tag}" is already used by inbound "${existing.name}" on this server. ` +
        'Xray refuses to start when two inbounds share a tag.',
    );
  }
}

export async function listInbounds(query: AdvancedListQuery, paging: { skip: number; take: number }) {
  const where: Prisma.InboundWhereInput = {};
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { tag: { contains: query.search, mode: 'insensitive' } },
      { remarks: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  if (query.serverId) where.serverId = query.serverId;
  if (query.enabled !== undefined) where.enabled = query.enabled;

  const [items, total] = await Promise.all([
    prisma.inbound.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      skip: paging.skip,
      take: paging.take,
      include: { server: serverSelect },
    }),
    prisma.inbound.count({ where }),
  ]);
  return { items, total };
}

export async function getInbound(id: string) {
  const inbound = await prisma.inbound.findUnique({ where: { id }, include: { server: serverSelect } });
  if (!inbound) throw new NotFoundError('Inbound');
  return inbound;
}

export async function createInbound(input: CreateInboundInput, actor: ActorContext) {
  await assertServer(input.serverId);
  await assertInboundTagFree(input.serverId, input.tag);
  if (input.enabled ?? true) await assertInboundPortAvailable({ port: input.port });

  let inbound;
  try {
    inbound = await prisma.inbound.create({
      data: {
        name: input.name,
        serverId: input.serverId,
        tag: input.tag,
        protocol: input.protocol ?? 'vless',
        listen: input.listen || '0.0.0.0',
        port: input.port,
        settings: (input.settings ?? {}) as Prisma.InputJsonValue,
        streamSettings: (input.streamSettings ?? {}) as Prisma.InputJsonValue,
        sniffing: (input.sniffing ?? {}) as Prisma.InputJsonValue,
        enabled: input.enabled ?? true,
        sortOrder: input.sortOrder ?? 0,
        remarks: input.remarks ?? null,
        createdById: actor.id,
      },
      include: { server: serverSelect },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`Tag "${input.tag}" is already used.`);
    throw error;
  }

  await record(actor, AUDIT_ACTIONS.INBOUND_CREATE, 'inbound', inbound.id, {
    name: inbound.name,
    tag: inbound.tag,
    port: inbound.port,
    protocol: inbound.protocol,
  });
  triggerXraySync();
  return inbound;
}

export async function updateInbound(id: string, input: UpdateInboundInput, actor: ActorContext) {
  const current = await prisma.inbound.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Inbound');
  if (input.serverId) await assertServer(input.serverId);

  const nextServerId = input.serverId ?? current.serverId;
  const nextPort = input.port ?? current.port;
  const nextEnabled = input.enabled ?? current.enabled;
  const nextTag = input.tag ?? current.tag;

  if (input.tag !== undefined || input.serverId !== undefined) {
    await assertInboundTagFree(nextServerId, nextTag, id);
  }
  const portChanged = input.port !== undefined && input.port !== current.port;
  if (nextEnabled && (portChanged || input.enabled === true)) {
    await assertInboundPortAvailable({ port: nextPort, excludeId: id });
  }

  const data: Prisma.InboundUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.serverId !== undefined) data.server = { connect: { id: input.serverId } };
  if (input.tag !== undefined) data.tag = input.tag;
  if (input.protocol !== undefined) data.protocol = input.protocol;
  if (input.listen !== undefined) data.listen = input.listen || '0.0.0.0';
  if (input.port !== undefined) data.port = input.port;
  if (input.settings !== undefined) data.settings = input.settings as Prisma.InputJsonValue;
  if (input.streamSettings !== undefined) {
    data.streamSettings = input.streamSettings as Prisma.InputJsonValue;
  }
  if (input.sniffing !== undefined) data.sniffing = input.sniffing as Prisma.InputJsonValue;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.remarks !== undefined) data.remarks = input.remarks;

  let updated;
  try {
    updated = await prisma.inbound.update({ where: { id }, data, include: { server: serverSelect } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`Tag "${nextTag}" is already used.`);
    throw error;
  }

  await record(actor, AUDIT_ACTIONS.INBOUND_UPDATE, 'inbound', id, { fields: Object.keys(input) });
  triggerXraySync();
  return updated;
}

export async function deleteInbound(id: string, actor: ActorContext) {
  const inbound = await prisma.inbound.findUnique({ where: { id } });
  if (!inbound) throw new NotFoundError('Inbound');

  await prisma.inbound.delete({ where: { id } });
  await record(actor, AUDIT_ACTIONS.INBOUND_DELETE, 'inbound', id, {
    name: inbound.name,
    tag: inbound.tag,
    port: inbound.port,
  });
  triggerXraySync();
  return { id };
}

// -----------------------------------------------------------------------------
// Outbounds
// -----------------------------------------------------------------------------

export interface CreateOutboundInput {
  name: string;
  serverId: string;
  tag: string;
  protocol?: string;
  settings?: Record<string, unknown>;
  streamSettings?: Record<string, unknown>;
  sendThrough?: string;
  enabled?: boolean;
  sortOrder?: number;
  remarks?: string;
}

export type UpdateOutboundInput = Partial<CreateOutboundInput>;

async function assertOutboundTagFree(serverId: string, tag: string, excludeId?: string) {
  const existing = await prisma.outbound.findFirst({
    where: { serverId, tag, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { name: true },
  });
  if (existing) {
    throw new ConflictError(`Tag "${tag}" is already used by outbound "${existing.name}".`);
  }
}

export async function listOutbounds(
  query: AdvancedListQuery,
  paging: { skip: number; take: number },
) {
  const where: Prisma.OutboundWhereInput = {};
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { tag: { contains: query.search, mode: 'insensitive' } },
      { remarks: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  if (query.serverId) where.serverId = query.serverId;
  if (query.enabled !== undefined) where.enabled = query.enabled;

  const [items, total] = await Promise.all([
    prisma.outbound.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      skip: paging.skip,
      take: paging.take,
      include: { server: serverSelect },
    }),
    prisma.outbound.count({ where }),
  ]);
  return { items, total };
}

export async function getOutbound(id: string) {
  const outbound = await prisma.outbound.findUnique({
    where: { id },
    include: { server: serverSelect },
  });
  if (!outbound) throw new NotFoundError('Outbound');
  return outbound;
}

export async function createOutbound(input: CreateOutboundInput, actor: ActorContext) {
  await assertServer(input.serverId);
  await assertOutboundTagFree(input.serverId, input.tag);

  let outbound;
  try {
    outbound = await prisma.outbound.create({
      data: {
        name: input.name,
        serverId: input.serverId,
        tag: input.tag,
        protocol: input.protocol ?? 'freedom',
        settings: (input.settings ?? {}) as Prisma.InputJsonValue,
        streamSettings: (input.streamSettings ?? {}) as Prisma.InputJsonValue,
        sendThrough: input.sendThrough ?? null,
        enabled: input.enabled ?? true,
        sortOrder: input.sortOrder ?? 0,
        remarks: input.remarks ?? null,
        createdById: actor.id,
      },
      include: { server: serverSelect },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`Tag "${input.tag}" is already used.`);
    throw error;
  }

  await record(actor, AUDIT_ACTIONS.OUTBOUND_CREATE, 'outbound', outbound.id, {
    name: outbound.name,
    tag: outbound.tag,
    protocol: outbound.protocol,
  });
  triggerXraySync();
  return outbound;
}

export async function updateOutbound(id: string, input: UpdateOutboundInput, actor: ActorContext) {
  const current = await prisma.outbound.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Outbound');
  if (input.serverId) await assertServer(input.serverId);

  if (input.tag !== undefined || input.serverId !== undefined) {
    await assertOutboundTagFree(input.serverId ?? current.serverId, input.tag ?? current.tag, id);
  }

  const data: Prisma.OutboundUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.serverId !== undefined) data.server = { connect: { id: input.serverId } };
  if (input.tag !== undefined) data.tag = input.tag;
  if (input.protocol !== undefined) data.protocol = input.protocol;
  if (input.settings !== undefined) data.settings = input.settings as Prisma.InputJsonValue;
  if (input.streamSettings !== undefined) {
    data.streamSettings = input.streamSettings as Prisma.InputJsonValue;
  }
  if (input.sendThrough !== undefined) data.sendThrough = input.sendThrough;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.remarks !== undefined) data.remarks = input.remarks;

  let updated;
  try {
    updated = await prisma.outbound.update({
      where: { id },
      data,
      include: { server: serverSelect },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('That tag is already used.');
    throw error;
  }

  await record(actor, AUDIT_ACTIONS.OUTBOUND_UPDATE, 'outbound', id, { fields: Object.keys(input) });
  triggerXraySync();
  return updated;
}

export async function deleteOutbound(id: string, actor: ActorContext) {
  const outbound = await prisma.outbound.findUnique({ where: { id } });
  if (!outbound) throw new NotFoundError('Outbound');

  await prisma.outbound.delete({ where: { id } });
  await record(actor, AUDIT_ACTIONS.OUTBOUND_DELETE, 'outbound', id, {
    name: outbound.name,
    tag: outbound.tag,
  });
  triggerXraySync();
  return { id };
}

// -----------------------------------------------------------------------------
// Routing rules
// -----------------------------------------------------------------------------

export interface CreateRoutingRuleInput {
  name: string;
  serverId: string;
  sortOrder?: number;
  enabled?: boolean;
  outboundTag?: string;
  balancerTag?: string;
  inboundTags?: string[];
  domain?: string[];
  ip?: string[];
  port?: string;
  sourceIp?: string[];
  sourcePort?: string;
  protocol?: string[];
  network?: 'tcp' | 'udp' | 'tcp,udp';
  remarks?: string;
}

/**
 * Unlike creation, an update may explicitly CLEAR a field by sending `null`
 * (e.g. dropping the balancerTag when switching a rule to an outboundTag).
 */
export type UpdateRoutingRuleInput = Partial<
  Omit<
    CreateRoutingRuleInput,
    'outboundTag' | 'balancerTag' | 'port' | 'sourcePort' | 'network' | 'remarks'
  >
> & {
  outboundTag?: string | null;
  balancerTag?: string | null;
  port?: string | null;
  sourcePort?: string | null;
  network?: 'tcp' | 'udp' | 'tcp,udp' | null;
  remarks?: string | null;
};

export async function listRoutingRules(
  query: AdvancedListQuery,
  paging: { skip: number; take: number },
) {
  const where: Prisma.RoutingRuleWhereInput = {};
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { outboundTag: { contains: query.search, mode: 'insensitive' } },
      { remarks: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  if (query.serverId) where.serverId = query.serverId;
  if (query.enabled !== undefined) where.enabled = query.enabled;

  const [items, total] = await Promise.all([
    prisma.routingRule.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      skip: paging.skip,
      take: paging.take,
      include: { server: serverSelect },
    }),
    prisma.routingRule.count({ where }),
  ]);
  return { items, total };
}

export async function getRoutingRule(id: string) {
  const rule = await prisma.routingRule.findUnique({
    where: { id },
    include: { server: serverSelect },
  });
  if (!rule) throw new NotFoundError('Routing rule');
  return rule;
}

export async function createRoutingRule(input: CreateRoutingRuleInput, actor: ActorContext) {
  await assertServer(input.serverId);

  const rule = await prisma.routingRule.create({
    data: {
      name: input.name,
      serverId: input.serverId,
      sortOrder: input.sortOrder ?? 0,
      enabled: input.enabled ?? true,
      outboundTag: input.outboundTag ?? null,
      balancerTag: input.balancerTag ?? null,
      inboundTags: input.inboundTags ?? [],
      domain: input.domain ?? [],
      ip: input.ip ?? [],
      port: input.port ?? null,
      sourceIp: input.sourceIp ?? [],
      sourcePort: input.sourcePort ?? null,
      protocol: input.protocol ?? [],
      network: input.network ?? null,
      remarks: input.remarks ?? null,
      createdById: actor.id,
    },
    include: { server: serverSelect },
  });

  await record(actor, AUDIT_ACTIONS.ROUTING_CREATE, 'routing_rule', rule.id, {
    name: rule.name,
    outboundTag: rule.outboundTag,
    balancerTag: rule.balancerTag,
  });
  triggerXraySync();
  return rule;
}

export async function updateRoutingRule(
  id: string,
  input: UpdateRoutingRuleInput,
  actor: ActorContext,
) {
  const current = await prisma.routingRule.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Routing rule');
  if (input.serverId) await assertServer(input.serverId);

  // A rule with neither tag would be dropped by the renderer, so reject it at
  // the edge instead of letting it sit in the UI looking active.
  const nextOutbound = input.outboundTag !== undefined ? input.outboundTag : current.outboundTag;
  const nextBalancer = input.balancerTag !== undefined ? input.balancerTag : current.balancerTag;
  if (!nextOutbound && !nextBalancer) {
    throw new ValidationError('A routing rule needs an outboundTag or a balancerTag');
  }

  const data: Prisma.RoutingRuleUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.serverId !== undefined) data.server = { connect: { id: input.serverId } };
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.outboundTag !== undefined) data.outboundTag = input.outboundTag || null;
  if (input.balancerTag !== undefined) data.balancerTag = input.balancerTag || null;
  if (input.inboundTags !== undefined) data.inboundTags = input.inboundTags;
  if (input.domain !== undefined) data.domain = input.domain;
  if (input.ip !== undefined) data.ip = input.ip;
  if (input.port !== undefined) data.port = input.port || null;
  if (input.sourceIp !== undefined) data.sourceIp = input.sourceIp;
  if (input.sourcePort !== undefined) data.sourcePort = input.sourcePort || null;
  if (input.protocol !== undefined) data.protocol = input.protocol;
  if (input.network !== undefined) data.network = input.network;
  if (input.remarks !== undefined) data.remarks = input.remarks;

  const updated = await prisma.routingRule.update({
    where: { id },
    data,
    include: { server: serverSelect },
  });

  await record(actor, AUDIT_ACTIONS.ROUTING_UPDATE, 'routing_rule', id, {
    fields: Object.keys(input),
  });
  triggerXraySync();
  return updated;
}

export async function deleteRoutingRule(id: string, actor: ActorContext) {
  const rule = await prisma.routingRule.findUnique({ where: { id } });
  if (!rule) throw new NotFoundError('Routing rule');

  await prisma.routingRule.delete({ where: { id } });
  await record(actor, AUDIT_ACTIONS.ROUTING_DELETE, 'routing_rule', id, { name: rule.name });
  triggerXraySync();
  return { id };
}

// -----------------------------------------------------------------------------
// Reverse proxy
// -----------------------------------------------------------------------------

export interface CreateReverseProxyInput {
  name: string;
  serverId: string;
  role: 'BRIDGE' | 'PORTAL';
  tag: string;
  domain: string;
  enabled?: boolean;
  remarks?: string;
}

export type UpdateReverseProxyInput = Partial<CreateReverseProxyInput>;

async function assertReverseTagFree(serverId: string, tag: string, excludeId?: string) {
  const existing = await prisma.reverseProxy.findFirst({
    where: { serverId, tag, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { name: true },
  });
  if (existing) {
    throw new ConflictError(`Tag "${tag}" is already used by reverse proxy "${existing.name}".`);
  }
}

export async function listReverseProxies(
  query: AdvancedListQuery,
  paging: { skip: number; take: number },
) {
  const where: Prisma.ReverseProxyWhereInput = {};
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { tag: { contains: query.search, mode: 'insensitive' } },
      { domain: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  if (query.serverId) where.serverId = query.serverId;
  if (query.enabled !== undefined) where.enabled = query.enabled;
  if (query.role) where.role = query.role;

  const [items, total] = await Promise.all([
    prisma.reverseProxy.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: paging.skip,
      take: paging.take,
      include: { server: serverSelect },
    }),
    prisma.reverseProxy.count({ where }),
  ]);
  return { items, total };
}

export async function getReverseProxy(id: string) {
  const row = await prisma.reverseProxy.findUnique({
    where: { id },
    include: { server: serverSelect },
  });
  if (!row) throw new NotFoundError('Reverse proxy');
  return row;
}

export async function createReverseProxy(input: CreateReverseProxyInput, actor: ActorContext) {
  await assertServer(input.serverId);
  await assertReverseTagFree(input.serverId, input.tag);

  let row;
  try {
    row = await prisma.reverseProxy.create({
      data: {
        name: input.name,
        serverId: input.serverId,
        role: input.role,
        tag: input.tag,
        domain: input.domain,
        enabled: input.enabled ?? true,
        remarks: input.remarks ?? null,
        createdById: actor.id,
      },
      include: { server: serverSelect },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`Tag "${input.tag}" is already used.`);
    throw error;
  }

  await record(actor, AUDIT_ACTIONS.REVERSE_PROXY_CREATE, 'reverse_proxy', row.id, {
    name: row.name,
    role: row.role,
    tag: row.tag,
    domain: row.domain,
  });
  triggerXraySync();
  return row;
}

export async function updateReverseProxy(
  id: string,
  input: UpdateReverseProxyInput,
  actor: ActorContext,
) {
  const current = await prisma.reverseProxy.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Reverse proxy');
  if (input.serverId) await assertServer(input.serverId);

  if (input.tag !== undefined || input.serverId !== undefined) {
    await assertReverseTagFree(input.serverId ?? current.serverId, input.tag ?? current.tag, id);
  }

  const data: Prisma.ReverseProxyUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.serverId !== undefined) data.server = { connect: { id: input.serverId } };
  if (input.role !== undefined) data.role = input.role;
  if (input.tag !== undefined) data.tag = input.tag;
  if (input.domain !== undefined) data.domain = input.domain;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.remarks !== undefined) data.remarks = input.remarks;

  let updated;
  try {
    updated = await prisma.reverseProxy.update({
      where: { id },
      data,
      include: { server: serverSelect },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('That tag is already used.');
    throw error;
  }

  await record(actor, AUDIT_ACTIONS.REVERSE_PROXY_UPDATE, 'reverse_proxy', id, {
    fields: Object.keys(input),
  });
  triggerXraySync();
  return updated;
}

export async function deleteReverseProxy(id: string, actor: ActorContext) {
  const row = await prisma.reverseProxy.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Reverse proxy');

  await prisma.reverseProxy.delete({ where: { id } });
  await record(actor, AUDIT_ACTIONS.REVERSE_PROXY_DELETE, 'reverse_proxy', id, {
    name: row.name,
    tag: row.tag,
  });
  triggerXraySync();
  return { id };
}

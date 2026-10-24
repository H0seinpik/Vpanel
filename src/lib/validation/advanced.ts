import { z } from 'zod';

/**
 * Request validation for the advanced Xray objects (Phase 3).
 *
 * Kept in its own module so `validation/index.ts` — which every existing route
 * imports — stays untouched. The shapes mirror the Prisma models exactly; the
 * raw Xray sections are accepted as JSON objects and validated by the binary
 * (`xray run -test`) before they ever reach the live node.
 */

const jsonObject = z.record(z.unknown());

const tag = z.string().trim().min(1, 'A tag is required').max(120);
const name = z.string().trim().min(1, 'A name is required').max(120);
const serverId = z.string().min(1, 'A server must be selected');
const remarks = z.string().max(500).optional();
const sortOrder = z.coerce.number().int().min(-100000).max(100000).optional();

// -----------------------------------------------------------------------------
// Inbounds
// -----------------------------------------------------------------------------

export const createInboundSchema = z.object({
  name,
  serverId,
  tag,
  protocol: z.string().trim().min(1).max(40).default('vless'),
  listen: z.string().trim().max(64).default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65535),
  settings: jsonObject.optional(),
  streamSettings: jsonObject.optional(),
  sniffing: jsonObject.optional(),
  enabled: z.boolean().optional().default(true),
  sortOrder,
  remarks,
});

export const updateInboundSchema = createInboundSchema.partial();

// -----------------------------------------------------------------------------
// Outbounds
// -----------------------------------------------------------------------------

export const createOutboundSchema = z.object({
  name,
  serverId,
  tag,
  protocol: z.string().trim().min(1).max(40).default('freedom'),
  settings: jsonObject.optional(),
  streamSettings: jsonObject.optional(),
  sendThrough: z.string().trim().max(64).optional(),
  enabled: z.boolean().optional().default(true),
  sortOrder,
  remarks,
});

export const updateOutboundSchema = createOutboundSchema.partial();

// -----------------------------------------------------------------------------
// Routing rules
// -----------------------------------------------------------------------------

export const createRoutingRuleSchema = z
  .object({
    name,
    serverId,
    sortOrder,
    enabled: z.boolean().optional().default(true),
    outboundTag: z.string().trim().max(120).optional(),
    balancerTag: z.string().trim().max(120).optional(),
    inboundTags: z.array(z.string().trim().max(120)).max(64).optional(),
    domain: z.array(z.string().trim().max(512)).max(1024).optional(),
    ip: z.array(z.string().trim().max(128)).max(1024).optional(),
    port: z.string().trim().max(128).optional(),
    sourceIp: z.array(z.string().trim().max(128)).max(64).optional(),
    sourcePort: z.string().trim().max(128).optional(),
    protocol: z.array(z.string().trim().max(40)).max(32).optional(),
    network: z.enum(['tcp', 'udp', 'tcp,udp']).optional(),
    remarks,
  })
  .refine((value) => Boolean(value.outboundTag) || Boolean(value.balancerTag), {
    message: 'A routing rule needs an outboundTag or a balancerTag',
    path: ['outboundTag'],
  });

export const updateRoutingRuleSchema = z.object({
  name: name.optional(),
  serverId: serverId.optional(),
  sortOrder,
  enabled: z.boolean().optional(),
  outboundTag: z.string().trim().max(120).nullable().optional(),
  balancerTag: z.string().trim().max(120).nullable().optional(),
  inboundTags: z.array(z.string().trim().max(120)).max(64).optional(),
  domain: z.array(z.string().trim().max(512)).max(1024).optional(),
  ip: z.array(z.string().trim().max(128)).max(1024).optional(),
  port: z.string().trim().max(128).nullable().optional(),
  sourceIp: z.array(z.string().trim().max(128)).max(64).optional(),
  sourcePort: z.string().trim().max(128).nullable().optional(),
  protocol: z.array(z.string().trim().max(40)).max(32).optional(),
  network: z.enum(['tcp', 'udp', 'tcp,udp']).nullable().optional(),
  remarks: z.string().max(500).nullable().optional(),
});

// -----------------------------------------------------------------------------
// Reverse proxy
// -----------------------------------------------------------------------------

export const createReverseProxySchema = z.object({
  name,
  serverId,
  role: z.enum(['BRIDGE', 'PORTAL']),
  tag,
  domain: z.string().trim().min(1, 'A peer domain is required').max(255),
  enabled: z.boolean().optional().default(true),
  remarks,
});

export const updateReverseProxySchema = createReverseProxySchema.partial();

// -----------------------------------------------------------------------------
// List queries
// -----------------------------------------------------------------------------

export const advancedQuerySchema = z.object({
  search: z.string().optional(),
  serverId: z.string().optional(),
  enabled: z.enum(['true', 'false']).optional(),
  role: z.enum(['BRIDGE', 'PORTAL']).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});

import { prisma } from '@/lib/prisma';

/**
 * Phase 2 — merge operator-managed Xray objects into the generated node config.
 *
 * The base config (configurations + tunnels) is built by `renderXrayConfig()` and
 * must keep working EXACTLY as before. These helpers only APPEND:
 *
 *   - outbounds keep `direct` first, because Xray uses the FIRST outbound as the
 *     default route. Appending preserves that.
 *   - routing keeps the infrastructure rules (api, tunnels, private block) ahead
 *     of the operator's rules, so the panel's own behaviour cannot be overridden.
 *   - a row whose tag or port already exists is SKIPPED with a reason, never
 *     silently renamed: a duplicate tag makes Xray refuse to start entirely.
 *   - when there is nothing to merge the base object is returned untouched, so a
 *     panel with no advanced rows renders a byte-identical config.
 */

export interface AdvancedInboundRow {
  id: string;
  name: string;
  tag: string;
  protocol: string;
  listen: string;
  port: number;
  settings: unknown;
  streamSettings: unknown;
  sniffing: unknown;
  sortOrder: number;
}

export interface AdvancedOutboundRow {
  id: string;
  name: string;
  tag: string;
  protocol: string;
  settings: unknown;
  streamSettings: unknown;
  sendThrough: string | null;
  sortOrder: number;
}

export interface AdvancedRoutingRow {
  id: string;
  name: string;
  sortOrder: number;
  outboundTag: string | null;
  balancerTag: string | null;
  inboundTags: string[];
  domain: string[];
  ip: string[];
  port: string | null;
  sourceIp: string[];
  sourcePort: string | null;
  protocol: string[];
  network: string | null;
}

export interface AdvancedReverseRow {
  id: string;
  name: string;
  role: string;
  tag: string;
  domain: string;
}

export interface AdvancedObjects {
  inbounds: AdvancedInboundRow[];
  outbounds: AdvancedOutboundRow[];
  routing: AdvancedRoutingRow[];
  reverse: AdvancedReverseRow[];
}

export interface MergeResult {
  config: Record<string, unknown>;
  warnings: string[];
  counts: { inbounds: number; outbounds: number; rules: number; reverse: number };
  /** Ports the merged inbounds now hold — the supervisor records these so the
   *  next reconcile never bind-probes a socket its own node already owns. */
  ports: number[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Drop keys Xray would reject: empty strings, empty arrays, null/undefined. */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    if (typeof entry === 'string' && entry.trim() === '') continue;
    out[key] = entry;
  }
  return out;
}

/** Only add a JSON section when it actually carries something. */
function optionalSection(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : undefined;
}

export function mergeAdvancedObjects(
  base: Record<string, unknown>,
  advanced: AdvancedObjects,
): MergeResult {
  const config: Record<string, unknown> = { ...base };
  const warnings: string[] = [];
  const counts = { inbounds: 0, outbounds: 0, rules: 0, reverse: 0 };
  const addedPorts: number[] = [];

  // --- Inbounds ------------------------------------------------------------
  const baseInbounds = Array.isArray(base.inbounds) ? (base.inbounds as unknown[]) : [];
  const usedTags = new Set<string>();
  const usedPorts = new Set<number>();
  for (const entry of baseInbounds) {
    const record = asRecord(entry);
    if (typeof record.tag === 'string') usedTags.add(record.tag);
    const port = Number(record.port);
    if (Number.isFinite(port) && port > 0) usedPorts.add(port);
  }

  const extraInbounds: Array<Record<string, unknown>> = [];
  for (const row of advanced.inbounds) {
    const label = `inbound "${row.name}"`;
    if (!row.tag.trim()) {
      warnings.push(`${label} skipped: it has no tag`);
      continue;
    }
    if (usedTags.has(row.tag)) {
      warnings.push(`${label} skipped: tag "${row.tag}" is already used`);
      continue;
    }
    if (!Number.isInteger(row.port) || row.port <= 0 || row.port > 65535) {
      warnings.push(`${label} skipped: ${row.port} is not a valid port`);
      continue;
    }
    if (usedPorts.has(row.port)) {
      warnings.push(`${label} skipped: port ${row.port} is already used`);
      continue;
    }

    extraInbounds.push(
      compact({
        tag: row.tag,
        protocol: row.protocol,
        listen: row.listen || '0.0.0.0',
        port: row.port,
        settings: asRecord(row.settings),
        streamSettings: optionalSection(row.streamSettings),
        sniffing: optionalSection(row.sniffing),
      }),
    );
    usedTags.add(row.tag);
    usedPorts.add(row.port);
    addedPorts.push(row.port);
    counts.inbounds += 1;
  }
  if (extraInbounds.length > 0) {
    config.inbounds = [...baseInbounds, ...extraInbounds];
  }

  // --- Outbounds -----------------------------------------------------------
  const baseOutbounds = Array.isArray(base.outbounds) ? (base.outbounds as unknown[]) : [];
  const usedOutboundTags = new Set<string>();
  for (const entry of baseOutbounds) {
    const record = asRecord(entry);
    if (typeof record.tag === 'string') usedOutboundTags.add(record.tag);
  }

  const extraOutbounds: Array<Record<string, unknown>> = [];
  for (const row of advanced.outbounds) {
    const label = `outbound "${row.name}"`;
    if (!row.tag.trim()) {
      warnings.push(`${label} skipped: it has no tag`);
      continue;
    }
    if (usedOutboundTags.has(row.tag)) {
      warnings.push(`${label} skipped: tag "${row.tag}" is already used`);
      continue;
    }

    extraOutbounds.push(
      compact({
        tag: row.tag,
        protocol: row.protocol,
        settings: asRecord(row.settings),
        streamSettings: optionalSection(row.streamSettings),
        sendThrough: row.sendThrough,
      }),
    );
    usedOutboundTags.add(row.tag);
    counts.outbounds += 1;
  }
  if (extraOutbounds.length > 0) {
    config.outbounds = [...baseOutbounds, ...extraOutbounds];
  }

  // --- Routing -------------------------------------------------------------
  const routing = asRecord(base.routing);
  const baseRules = Array.isArray(routing.rules) ? (routing.rules as unknown[]) : [];

  const extraRules: Array<Record<string, unknown>> = [];
  for (const row of advanced.routing) {
    if (!row.outboundTag && !row.balancerTag) {
      warnings.push(`routing rule "${row.name}" skipped: no outboundTag or balancerTag`);
      continue;
    }
    extraRules.push(
      compact({
        type: 'field',
        outboundTag: row.outboundTag ?? undefined,
        balancerTag: row.balancerTag ?? undefined,
        inboundTag: row.inboundTags,
        domain: row.domain,
        ip: row.ip,
        port: row.port ?? undefined,
        sourceIP: row.sourceIp,
        sourcePort: row.sourcePort ?? undefined,
        protocol: row.protocol,
        network: row.network ?? undefined,
      }),
    );
    counts.rules += 1;
  }
  if (extraRules.length > 0) {
    // Operator rules go AFTER the infrastructure rules, never before.
    config.routing = { ...routing, rules: [...baseRules, ...extraRules] };
  }

  // --- Reverse proxy -------------------------------------------------------
  const bridges = advanced.reverse
    .filter((row) => row.role === 'BRIDGE')
    .map((row) => compact({ tag: row.tag, domain: row.domain }));
  const portals = advanced.reverse
    .filter((row) => row.role === 'PORTAL')
    .map((row) => compact({ tag: row.tag, domain: row.domain }));

  if (bridges.length > 0 || portals.length > 0) {
    config.reverse = {
      ...(bridges.length > 0 ? { bridges } : {}),
      ...(portals.length > 0 ? { portals } : {}),
    };
    counts.reverse = bridges.length + portals.length;
  }

  return { config, warnings, counts, ports: addedPorts };
}

/**
 * Load every enabled advanced object.
 *
 * No server filter, deliberately: `renderXrayConfig()` renders ONE local
 * `config.json`, and it already treats every configuration row the same way.
 * Filtering here would silently drop rows the operator can see in the UI.
 */
export async function loadAdvancedObjects(): Promise<AdvancedObjects> {
  const [inbounds, outbounds, routing, reverse] = await Promise.all([
    prisma.inbound.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.outbound.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.routingRule.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.reverseProxy.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  return {
    inbounds: inbounds as unknown as AdvancedInboundRow[],
    outbounds: outbounds as unknown as AdvancedOutboundRow[],
    routing: routing as unknown as AdvancedRoutingRow[],
    reverse: reverse as unknown as AdvancedReverseRow[],
  };
}

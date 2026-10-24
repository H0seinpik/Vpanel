import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ConfigStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getEnv } from '@/lib/env';
import { applyCredential, generateConfig } from '@/services/config-generator';
import { clientEmailFor } from '@/services/providers/identity';
import {
  describePortConflict,
  portFromBindError,
  staticPortConflict,
  startupFailureLine,
  type PortConflict,
} from '@/services/port-conflicts';
import { planPortSharing, resolvePortLayout } from '@/services/port-sharing';
import { parseX25519Output, serverRealitySettings } from '@/services/reality';
import { assertRenderIsApplicable, decideEmptyRender } from '@/services/render-guard';
import { mayWriteNodeConfig } from '@/services/worker-lock';
import { loadAdvancedObjects, mergeAdvancedObjects } from './xray-advanced';

/**
 * Xray supervisor.
 *
 * This is the missing link between the panel and the proxy server. Without it
 * the panel only *generates* configurations; nothing ever tells Xray what to
 * serve, which produced three very confusing behaviours:
 *
 *   - a configuration created in the panel did not work until someone ran a
 *     sync script by hand,
 *   - traffic was never counted (there was nothing reading the node's counters),
 *   - a deleted configuration kept working, because Xray still held the old
 *     config file.
 *
 * The supervisor fixes all three by reconciling the database against the node:
 *
 *   renderXrayConfig()  ->  compare hash with what is applied
 *                       ->  write + restart Xray only when it actually changed
 *
 * `NODE_PROVIDER=xray` additionally makes traffic collection read Xray's own
 * per-user counters, so the numbers are real rather than simulated.
 *
 * Safety: everything here is local to the machine running the panel. The stats
 * API is bound to 127.0.0.1 and never exposed.
 */

// -----------------------------------------------------------------------------
// Paths and state
// -----------------------------------------------------------------------------

export interface XrayPaths {
  dir: string;
  exe: string;
  config: string;
  log: string;
  state: string;
  stats: string;
  tunnelStats: string;
}

export function getXrayPaths(): XrayPaths {
  const dir = getEnv().XRAY_DIR;
  return {
    dir,
    exe: join(dir, 'xray.exe'),
    config: join(dir, 'config.json'),
    log: join(dir, 'xray.log'),
    state: join(dir, '.vpanel-state.json'),
    stats: join(dir, '.vpanel-stats.json'),
    tunnelStats: join(dir, '.vpanel-tunnel-stats.json'),
  };
}

/** Where the TLS certificate for TLS-requiring inbounds lives. */
export function getCertificatePaths(): { cert: string; key: string } {
  const env = getEnv();
  const dir = env.XRAY_DIR;
  return {
    cert: env.XRAY_CERT_FILE || join(dir, 'cert.pem'),
    key: env.XRAY_KEY_FILE || join(dir, 'key.pem'),
  };
}

/**
 * The `certificates` entry Xray needs on a TLS inbound, or null when no usable
 * pair is present.
 *
 * Trojan and VLESS+TLS cannot serve without this: the client opens a TLS
 * handshake and the server has nothing to present, so the connection dies with
 * no useful error on either side.
 */
function getTlsCertificate(): { certificateFile: string; keyFile: string } | null {
  const { cert, key } = getCertificatePaths();
  if (!existsSync(cert) || !existsSync(key)) return null;
  return { certificateFile: cert, keyFile: key };
}

/**
 * SHA-256 of the certificate's DER form, hex-encoded.
 *
 * This is the value Xray 26 wants in `pinnedPeerCertSha256`. Computed from the
 * PEM directly — no openssl at runtime, and no need to shell out per render.
 */
export function certificatePin(): string | null {
  const { cert } = getCertificatePaths();
  if (!existsSync(cert)) return null;

  try {
    const pem = readFileSync(cert, 'utf8');
    const base64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    if (!base64) return null;
    return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Add the certificate pin to a configuration's parameters before rendering the
 * CLIENT side.
 *
 * A self-signed certificate is not in any trust store, so without the pin every
 * handshake fails. Pinning is what `allowInsecure` used to approximate, and it
 * is strictly safer: it trusts exactly one certificate rather than disabling
 * verification.
 *
 * The server inbound does not want this field, so `renderXrayConfig` strips it
 * back out.
 */
export function withTlsPin(params: Record<string, unknown>): Record<string, unknown> {
  if (String(params.security ?? '') !== 'tls') return params;

  const pin = certificatePin();
  if (!pin) return params;

  return { ...params, pinnedPeerCertSha256: pin };
}

interface SupervisorState {
  pid?: number;
  appliedHash?: string;
  appliedAt?: string;
  /**
   * Public ports the *running* node is known to hold.
   *
   * `renderXrayConfig()` probes each port with a bind attempt to catch a
   * third-party holder. It cannot distinguish "a stranger holds 443" from "our
   * own Xray holds 443" — and on Windows the bind succeeds either way
   * (`exclusive: true` on a specific host does not always collide with Xray's
   * wildcard bind), so the probe currently passes by luck. If that behaviour
   * ever changes, every tick would drop the group, change the hash, and restart
   * Xray — the 2026-09-28 flapping outage. Recording the applied ports and
   * skipping the probe for a port we already serve makes that impossible.
   */
  appliedPorts?: number[];
  /**
   * How many consecutive reconciles have rendered an empty config.
   *
   * Used to tell a real "the operator removed everything" apart from a
   * transient empty read. Persisted on disk, not in memory, because the
   * worker that observes the transient read may not be the one that sees the
   * next tick — and because a restart midway must not reset the count.
   */
  emptyRenderCount?: number;
}

function readState(): SupervisorState {
  const { state } = getXrayPaths();
  if (!existsSync(state)) return {};
  try {
    return JSON.parse(readFileSync(state, 'utf8')) as SupervisorState;
  } catch {
    return {};
  }
}

function writeState(next: SupervisorState): void {
  const { state } = getXrayPaths();
  try {
    const temp = `${state}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(temp, state);
  } catch {
    // Non-fatal: losing the state file only costs an extra restart.
  }
}

/** Is the panel configured to manage a local Xray at all? */
export function isSupervisorEnabled(): boolean {
  const env = getEnv();
  return env.XRAY_ENABLED === 'true' && existsSync(getXrayPaths().exe);
}

// -----------------------------------------------------------------------------
// Config rendering
// -----------------------------------------------------------------------------

interface XrayInbound {
  tag?: string;
  listen?: string;
  port: number;
  protocol: string;
  settings: Record<string, unknown>;
  streamSettings?: unknown;
  sniffing?: unknown;
  [key: string]: unknown;
}

/**
 * Protocols whose inbound can carry several users at once.
 *
 * SHADOWSOCKS IS INCLUDED — and it is the reason per-user accounting exists for
 * it at all. A single-user Shadowsocks inbound carries the cipher at the inbound
 * level (`settings.method` / `settings.password`) and has **no client email**.
 * Xray keys its per-user statistics on that email (`user>>>EMAIL>>>traffic>>>…`),
 * so a single-user inbound can only ever produce `inbound>>>` counters.
 *
 * Observed live 2026-09-28 before this fix: the Shadowsocks inbound had carried
 * **2.6 MB down / 708 KB up** — the busiest configuration on the node — while
 * there were **zero** `user>>>` counters for it. The panel could never attribute
 * a single byte, and the operator reported exactly that: "Shadowsocks does not
 * count traffic".
 *
 * MEASURED with Xray 26.9.8 (`xray run -test`), which shapes are even valid:
 *
 *   { method, password }                          → ACCEPTED (single user)
 *   { clients: [{ method, password, email }] }    → ACCEPTED (multi user)
 *   { method, clients: [{ password, email }] }    → REJECTED
 *        "failed to build inbound handler for protocol shadowsocks >
 *         unsupported cipher method:"  (empty — the method must be PER CLIENT)
 *   { method }  (no password, no clients)         → REJECTED
 *
 * So multi-user Shadowsocks is not a superset of the single-user shape: the
 * inbound-level `method`/`password` must be REMOVED and the method moved INTO
 * each client. `buildClient()` below does exactly that.
 */
const MULTI_USER = new Set(['VLESS', 'VMESS', 'TROJAN', 'SHADOWSOCKS']);

/**
 * Fields that must not survive at the inbound level once clients are rendered.
 *
 * A leftover `password` would become an implicit extra user, and a leftover
 * `method` makes Xray reject the whole config (see the measurement above). Both
 * are handled per client instead.
 */
const INBOUND_LEVEL_CREDENTIAL_FIELDS = ['method', 'password'] as const;

/**
 * Can anything bind this port right now?
 *
 * The static table catches the ports Windows owns forever. This catches the
 * rest: a third-party process (IIS, another proxy, a leftover Xray) that holds
 * the port today. Resolving `127.0.0.1` is enough — if the port is taken on the
 * loopback interface it is taken for our inbound too, and `0.0.0.0` binds would
 * need elevation on some ports.
 *
 * Cheap by design: a single listen/close, bounded by a short timeout, so a
 * per-config probe on the 15 s reconcile tick costs nothing measurable.
 */
function probePortBindable(port: number, timeoutMs = 2_000): Promise<PortConflict | null> {
  return new Promise((resolve) => {
    const server = createServer();

    const finish = (conflict: PortConflict | null) => {
      clearTimeout(timer);
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        // Already closed.
      }
      resolve(conflict);
    };

    const timer = setTimeout(() => {
      finish({
        port,
        reason: 'did not respond to a bind attempt',
        fix: 'Pick a different port',
        permanent: false,
      });
    }, timeoutMs);

    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        finish({
          port,
          reason: 'already in use by another process on this machine',
          fix: `Stop the program holding ${port}, or give this configuration a different port`,
          permanent: false,
        });
        return;
      }
      // EACCES means a privileged or reserved range; treat it as fatal for us
      // because the panel never runs elevated.
      if (error.code === 'EACCES') {
        finish({
          port,
          reason: 'is in a range Windows does not let this program bind',
          fix: 'Pick a high port such as 8443, 2053 or 2087',
          permanent: true,
        });
        return;
      }
      finish({
        port,
        reason: `cannot be bound (${error.code ?? error.message})`,
        fix: 'Pick a different port',
        permanent: false,
      });
    });

    server.once('listening', () => finish(null));
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

/**
 * Turn a validation failure into one readable line.
 *
 * The generator validates with Zod, whose `message` is a multi-line JSON dump.
 * An operator reading "skipped configurations" needs to know *which field* is
 * wrong, not to parse JSON in a log file.
 */
export function describeRenderFailure(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> })?.issues;

  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .slice(0, 3)
      .map((issue) => {
        const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
        return path ? `${path} ${issue.message}` : String(issue.message);
      })
      .join('; ');
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export interface RenderResult {
  config: Record<string, unknown> | null;
  inbounds: number;
  ports: number[];
  skipped: string[];
  /**
   * Per-tunnel render failures, keyed by tunnel id. The supervisor persists
   * these into `Tunnel.lastError` after a reconcile so the UI can explain why an
   * enabled tunnel is not being served.
   */
  tunnelErrors?: Record<string, string>;
}

/** The fields the renderer needs from a `Tunnel` row. */
export interface TunnelRenderSpec {
  id: string;
  name: string;
  listenAddress: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  network: string;
}

/** Xray spells the transport list as a comma-separated `allowedNetwork`. */
export function tunnelAllowedNetwork(network: string): 'tcp' | 'udp' | 'tcp,udp' {
  switch (network) {
    case 'UDP':
      return 'udp';
    case 'TCP_UDP':
      return 'tcp,udp';
    default:
      return 'tcp';
  }
}

/**
 * Build the inbound for one tunnel.
 *
 * Xray 26 renamed `dokodemo-door` to `tunnel` and its settings to
 * `rewriteAddress` / `rewritePort`; both spellings are still accepted, but the
 * modern one is used here. Verified with `xray run -test` on 26.9.8:
 * `allowedNetwork: "tcp,udp"` + `rewriteAddress` + `rewritePort` is valid.
 *
 * Sniffing is deliberately disabled: a forwarder must pass bytes through
 * untouched, and sniffing would make Xray inspect (and potentially reroute) a
 * protocol it is not terminating.
 */
export function buildTunnelInbound(tunnel: TunnelRenderSpec): XrayInbound {
  return {
    listen: tunnel.listenAddress || '0.0.0.0',
    port: tunnel.listenPort,
    protocol: 'tunnel',
    settings: {
      allowedNetwork: tunnelAllowedNetwork(tunnel.network),
      rewriteAddress: tunnel.targetHost,
      rewritePort: tunnel.targetPort,
    },
    tag: `tunnel-${tunnel.id}`,
    sniffing: { enabled: false },
  };
}

/**
 * Build the node config from the database.
 *
 * One public inbound per port, each carrying every active assignment as a
 * client. Client emails are the assignment ids (see `clientEmailFor`), which is
 * what makes per-user traffic accounting possible.
 *
 * When several configurations target the SAME port, they are served through
 * Xray `fallbacks`: one public inbound holds the port and routes each client to
 * its own loopback inbound by request path. See `port-sharing.ts` for why this
 * is the only way to put more than one configuration on one port.
 *
 * `options.alreadyHeld` names ports the running node is known to own; those are
 * never bind-probed, so the reconcile can never mistake our own listener for a
 * third-party conflict and start flapping the config (see `SupervisorState`).
 */
export async function renderXrayConfig(
  options: { alreadyHeld?: readonly number[] } = {},
): Promise<RenderResult> {
  const env = getEnv();
  const alreadyHeld = new Set(options.alreadyHeld ?? []);

  const all = await prisma.configuration.findMany({
    include: {
      server: true,
      assignments: { where: { status: ConfigStatus.ACTIVE } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Tunnels are a separate table because they have no users or credentials.
  // They are rendered into the same node config, after the configurations, so
  // the port-collision checks can see both sets at once.
  const tunnelRows = await prisma.tunnel.findMany({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
  });

  // Operator-managed raw objects (Inbounds / Outbounds / Routing / Reverse).
  // Loaded here and merged at the very END, so the generated base is assembled
  // exactly as it always was.
  const advanced = await loadAdvancedObjects();

  const inbounds: XrayInbound[] = [];
  const usedTags = new Set<string>();
  const skipped: string[] = [];
  const tunnelErrors: Record<string, string> = {};
  const tunnels: XrayInbound[] = [];
  const tunnelPorts: number[] = [];
  const tunnelTags: string[] = [];

  // Group the serveable configurations by the port they want, so we can decide
  // per port whether it is a single direct inbound or a shared fallback set.
  const byPort = new Map<number, ServeableConfig[]>();

  for (const config of all) {
    if (config.status !== ConfigStatus.ACTIVE) {
      skipped.push(`${config.name} (status is ${config.status})`);
      continue;
    }
    if (config.assignments.length === 0) {
      skipped.push(`${config.name} (no active assignments)`);
      continue;
    }

    const publicParams = (config.params ?? {}) as Record<string, unknown>;
    const port = Number(publicParams.port ?? config.server.port);

    // A port that cannot be bound must be caught BEFORE it reaches Xray.
    //
    // Xray does not skip an inbound it cannot bind — it refuses to start at
    // all. So publishing one configuration on a Windows-owned port (445 is the
    // classic: SMB always holds it) silently takes down every other
    // configuration on the machine, and the only symptom is that all the other
    // ports stop answering. Worse, 445 still *looks* open because SMB is
    // listening there, so a client connects to file sharing and reports "no
    // connection" rather than "connection refused".
    const staticConflict = staticPortConflict(port);
    if (staticConflict) {
      skipped.push(describePortConflict(config.name, staticConflict));
      continue;
    }

    const entries = byPort.get(port) ?? [];
    entries.push({ config, port, publicParams });
    byPort.set(port, entries);
  }

  for (const [port, entries] of byPort) {
    // Nothing on the machine may already hold the port — unless we are the ones
    // holding it, which the reconcile loop cannot tell apart. Probing is only
    // meaningful for a port Xray is not already serving, so it is done once per
    // port here and its failure drops the whole group with one clear reason.
    //
    // A port recorded as already held by the running node is skipped outright:
    // probing it is what turned a healthy node into a restart loop on
    // 2026-09-28. `alreadyHeld` is re-derived from the applied config on every
    // tick, so a port we no longer serve is probed again immediately.
    const liveConflict = alreadyHeld.has(port) ? null : await probePortBindable(port);
    if (liveConflict) {
      for (const entry of entries) {
        skipped.push(describePortConflict(entry.config.name, liveConflict));
      }
      continue;
    }

    const candidates = entries.map((entry) => toShareCandidate(entry));
    const { mode, plan } = resolvePortLayout(candidates);

    if (mode === 'shared') {
      const outcome = renderSharedPort(entries, plan, usedTags, env.XRAY_API_PORT);
      inbounds.push(...outcome.inbounds);
      skipped.push(...outcome.skipped);
      continue;
    }

    // A single configuration on a port keeps the simple direct layout.
    const [entry] = entries;
    if (!entry) continue;
    const single = renderDirectInbound(entry, usedTags);
    if ('skipped' in single) {
      skipped.push(single.skipped);
    } else {
      inbounds.push(single.inbound);
    }
  }

  // Tunnels claim their own ports. A port already claimed by a configuration
  // (even one that will itself be skipped) is refused here: two inbounds cannot
  // bind the same socket, and Xray would abort the whole process.
  for (const row of tunnelRows) {
    const port = Number(row.listenPort);

    const reject = (reason: string) => {
      tunnelErrors[row.id] = reason;
      skipped.push(`${row.name} (${reason})`);
    };

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      reject(`${port} is not a valid TCP port number`);
      continue;
    }
    if (port === env.XRAY_API_PORT) {
      reject(`port ${port} is the panel's own Xray stats API`);
      continue;
    }
    if (byPort.has(port)) {
      reject(`port ${port} is already used by a configuration`);
      continue;
    }
    if (tunnelPorts.includes(port)) {
      reject(`port ${port} is already used by another tunnel`);
      continue;
    }

    const staticConflict = staticPortConflict(port);
    if (staticConflict) {
      reject(`${port} ${staticConflict.reason} — ${staticConflict.fix}`);
      continue;
    }

    const liveConflict = alreadyHeld.has(port) ? null : await probePortBindable(port);
    if (liveConflict) {
      reject(`${port} ${liveConflict.reason} — ${liveConflict.fix}`);
      continue;
    }

    const inbound = buildTunnelInbound({
      id: row.id,
      name: row.name,
      listenAddress: row.listenAddress,
      listenPort: port,
      targetHost: row.targetHost,
      targetPort: row.targetPort,
      network: row.network,
    });

    tunnels.push(inbound);
    tunnelPorts.push(port);
    if (inbound.tag) tunnelTags.push(inbound.tag);
  }

  if (
    inbounds.length === 0 &&
    tunnels.length === 0 &&
    advanced.inbounds.length === 0 &&
    advanced.reverse.length === 0
  ) {
    return { config: null, inbounds: 0, ports: [], skipped, tunnelErrors };
  }

  const routingRules: Array<Record<string, unknown>> = [
    { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
  ];

  // A forwarder may target a private address (a service on the same LAN, for
  // example). The blanket private-IP block below must therefore not apply to
  // tunnel traffic, or every such tunnel would silently blackhole.
  if (tunnelTags.length > 0) {
    routingRules.push({ type: 'field', inboundTag: tunnelTags, outboundTag: 'direct' });
  }

  routingRules.push({ type: 'field', ip: ['geoip:private'], outboundTag: 'blocked' });

  const config = {
    log: { loglevel: 'warning', access: 'none' },

    // --- Traffic accounting -------------------------------------------------
    // `stats` enables the counters; the per-user ones only exist because each
    // client carries a unique email and level 0 has user stats switched on.
    // `statsInboundUplink/Downlink` is what gives each tunnel its counters.
    stats: {},
    api: { tag: 'api', services: ['StatsService'] },
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true },
    },

    inbounds: [
      // Loopback-only management inbound for the stats API.
      {
        listen: '127.0.0.1',
        port: env.XRAY_API_PORT,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' },
        tag: 'api',
      },
      ...inbounds,
      ...tunnels,
    ],

    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'blocked' },
    ],

    routing: {
      domainStrategy: 'AsIs',
      rules: routingRules,
    },
  };

  // Append the operator-managed objects. The base arrays are never reordered or
  // replaced — see `xray-advanced.ts` for the merge contract.
  const merged = mergeAdvancedObjects(config, advanced);
  if (merged.warnings.length > 0) skipped.push(...merged.warnings);

  const publicPorts = [...new Set([...byPort.keys(), ...tunnelPorts, ...merged.ports])].filter(
    (port) => port > 0,
  );
  return {
    config: merged.config,
    inbounds: inbounds.length + tunnels.length + merged.counts.inbounds,
    ports: publicPorts,
    skipped,
    tunnelErrors,
  };
}

/** A configuration that passed the static checks and wants a port. */
interface ServeableConfig {
  config: {
    id: string;
    name: string;
    type: string;
    params: unknown;
    assignments: Array<{ id: string; credential: unknown }>;
  };
  port: number;
  publicParams: Record<string, unknown>;
}

function streamOf(params: Record<string, unknown>): { network: string; security: string; path: string | null } {
  return {
    network: String(params.network ?? 'tcp'),
    security: String(params.security ?? 'none'),
    path: params.path ? String(params.path) : null,
  };
}

function toShareCandidate(entry: ServeableConfig) {
  const stream = streamOf(entry.publicParams);
  return {
    id: entry.config.id,
    name: entry.config.name,
    protocol: entry.config.type,
    security: stream.security,
    network: stream.network,
    path: stream.path,
  };
}

/**
 * Render one inbound that owns its port outright.
 *
 * Returns either the inbound or the reason it could not be rendered, so a single
 * bad row can never throw out of the whole reconcile pass.
 */
function renderDirectInbound(
  entry: ServeableConfig,
  usedTags: Set<string>,
): { inbound: XrayInbound } | { skipped: string } {
  const { config, publicParams } = entry;
  const first = config.assignments[0]!;

  const rendered = renderInboundFor(config, publicParams, first, usedTags);
  if ('skipped' in rendered) return rendered;

  return { inbound: rendered.inbound };
}

/**
 * Render a set of configurations that share one public port via fallbacks.
 *
 * The public inbound is VLESS+TLS and carries NO tag — Xray requires a fallback
 * parent to be tagless. Each member becomes a loopback inbound with its own tag
 * and its own clients, and the public inbound routes to it by path.
 */
function renderSharedPort(
  entries: ServeableConfig[],
  plan: ReturnType<typeof planPortSharing>,
  usedTags: Set<string>,
  apiPort: number,
): { inbounds: XrayInbound[]; skipped: string[] } {
  const skipped: string[] = [];
  const members: XrayInbound[] = [];
  const fallbacks: Array<Record<string, unknown>> = [];

  for (const rejection of plan.rejected) {
    skipped.push(`${rejection.name} (${rejection.reason} — ${rejection.fix})`);
  }

  for (const member of plan.members) {
    const entry = entries.find((candidate) => candidate.config.id === member.id);
    if (!entry) continue;

    const { config, publicParams } = entry;
    const first = config.assignments[0]!;

    // The member binds loopback only. Nothing outside the machine may reach it
    // directly — the public listener is the single entry point, which is what
    // keeps the shared port coherent.
    const memberParams: Record<string, unknown> = {
      ...publicParams,
      port: member.internalPort,
      security: 'none', // TLS terminates on the public inbound, not here.
      path: member.path,
      network: 'ws',
    };

    const rendered = renderInboundFor(config, memberParams, first, usedTags);
    if ('skipped' in rendered) {
      skipped.push(rendered.skipped);
      continue;
    }

    const inbound = rendered.inbound;
    inbound.listen = '127.0.0.1';
    members.push(inbound);

    fallbacks.push({
      path: member.path,
      dest: member.internalPort,
      xver: 0,
    });
  }

  if (members.length === 0) return { inbounds: [], skipped };

  // Everything that arrives and matches no path goes to the blackhole, so a
  // probe or a stray browser request learns nothing about the service.
  fallbacks.push({ dest: 1 });

  const publicInbound: XrayInbound = {
    // No `tag`: Xray rejects a fallback parent that has one.
    listen: '0.0.0.0',
    port: entries[0]!.port,
    protocol: 'vless',
    settings: {
      clients: [],
      decryption: 'none',
      fallbacks,
    },
    streamSettings: {
      network: 'tcp',
      security: 'tls',
      tlsSettings: {
        alpn: ['http/1.1'],
        certificates: [getTlsCertificate()].filter(Boolean),
      },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
  };

  // A TLS inbound will not serve without a certificate.
  const certificate = getTlsCertificate();
  if (!certificate) {
    const { cert } = getCertificatePaths();
    return {
      inbounds: [],
      skipped: [
        ...skipped,
        `shared port ${entries[0]!.port} (needs TLS but no certificate at ${cert})`,
      ],
    };
  }
  if (Number(apiPort) === entries[0]!.port) {
    return { inbounds: [], skipped: [...skipped, `shared port ${entries[0]!.port} collides with the panel stats port`] };
  }

  return { inbounds: [publicInbound, ...members], skipped };
}

/**
 * Render a single inbound from a configuration's parameters.
 *
 * Shared by the direct and shared paths so the tag-uniqueness rule and the
 * per-config render isolation live in exactly one place.
 */
function renderInboundFor(
  config: ServeableConfig['config'],
  params: Record<string, unknown>,
  firstAssignment: { id: string; credential: unknown },
  usedTags: Set<string>,
): { inbound: XrayInbound } | { skipped: string } {
  // Rendering a single configuration must never take down the whole pass.
  // A row with malformed parameters (a missing address, an out-of-range port)
  // used to throw straight out of the reconcile job, so one bad configuration
  // stopped *every other* configuration from being served — which looks
  // exactly like "none of my configs work" and gives no clue why.
  let rendered;
  try {
    rendered = generateConfig(
      config.type as never,
      applyCredential(config.type as never, params, firstAssignment.credential as Record<string, unknown>),
      { name: config.name },
    );
  } catch (error) {
    return { skipped: `${config.name} (invalid parameters: ${describeRenderFailure(error)})` };
  }

  const inbound = rendered.serverInbound as XrayInbound;

  if (MULTI_USER.has(config.type)) {
    inbound.settings = applyClients(config.type, inbound.settings, config.assignments);
  }

  // A TLS inbound needs a certificate to serve at all. Without one the client
  // opens a TLS handshake and the server has nothing to present, so the
  // connection dies with no useful error on either side. Report it instead of
  // publishing a configuration that can never connect.
  const stream = inbound.streamSettings as
    | { security?: string; tlsSettings?: Record<string, unknown> }
    | undefined;

  if (stream?.security === 'tls') {
    const certificate = getTlsCertificate();
    if (!certificate) {
      const { cert } = getCertificatePaths();
      return { skipped: `${config.name} (needs TLS but no certificate at ${cert})` };
    }
    // The pin belongs to the CLIENT side; an inbound has no use for it and
    // Xray would reject it. Strip it and attach the certificate instead.
    const { pinnedPeerCertSha256: _pin, ...serverTls } = stream.tlsSettings ?? {};

    inbound.streamSettings = {
      ...stream,
      tlsSettings: { ...serverTls, certificates: [certificate] },
    };
  }

  // A REALITY inbound carries NO certificate — the client authenticates the
  // server with an x25519 public key from the link, so the node needs the
  // PRIVATE half plus the decoy destination that unauthenticated probes are
  // forwarded to. The generator only renders the client's half (publicKey,
  // shortId, spiderX); those belong in the link and must never reach the node,
  // so the whole object is replaced with the server-side one.
  if (stream?.security === 'reality') {
    const serverSettings = serverRealitySettings(params);
    if (!serverSettings) {
      return {
        skipped:
          `${config.name} (REALITY needs a private key - the configuration was not ` +
          `created with one. Re-save it so the panel can generate the keypair.)`,
      };
    }
    inbound.streamSettings = { ...stream, realitySettings: serverSettings };
  }

  // The tag MUST be unique per inbound. The generator produces a protocol
  // based tag ("vless-in"), so two configurations of the same protocol would
  // collide — and Xray refuses to start at all with
  // "existing tag found: vless-in", which takes down every other inbound too.
  // Overwrite unconditionally, and disambiguate if the suffix repeats.
  let tag = `vpanel-${config.id.slice(-6)}`;
  let suffix = 1;
  while (usedTags.has(tag)) {
    tag = `vpanel-${config.id.slice(-6)}-${suffix++}`;
  }
  usedTags.add(tag);
  inbound.tag = tag;

  return { inbound };
}

/**
 * Attach the per-assignment `clients` array to an inbound's settings.
 *
 * Pure and exported so the shape is unit-testable, because getting it wrong is
 * silent in one direction and fatal in the other:
 *
 *   - a missing `email`  → Xray emits no `user>>>` counter → traffic is carried
 *     but can never be attributed (the operator's "it does not count traffic")
 *   - a leftover inbound-level `method`/`password` beside `clients` → Xray
 *     REFUSES TO START the whole node ("unsupported cipher method:")
 *
 * Shadowsocks is the case that needs both rules. The cipher is per client, so it
 * is removed from the inbound and copied onto each client.
 */
export function applyClients(
  protocol: string,
  settings: Record<string, unknown>,
  assignments: { id: string; credential: unknown }[],
): Record<string, unknown> {
  const base = { ...settings };

  if (protocol === 'SHADOWSOCKS') {
    for (const field of INBOUND_LEVEL_CREDENTIAL_FIELDS) delete base[field];
  }

  // Captured before the delete above, so it can travel with each credential.
  const defaultMethod = settings.method;

  // The generator stamps the configuration-level flow (xtls-rprx-vision) on its
  // template client. Multi-user rendering rebuilds that array per assignment, and
  // the flow MUST travel with it: a REALITY/VLESS client authenticates fine
  // against a server entry without the flow, and then carries no data at all —
  // the "connected but no response" symptom.
  const configFlow = Array.isArray(settings.clients)
    ? (settings.clients[0] as Record<string, unknown> | undefined)?.flow
    : undefined;

  return {
    ...base,
    clients: assignments.map((assignment) =>
      buildClient(
        protocol,
        {
          ...((assignment.credential ?? {}) as Record<string, unknown>),
          ...(protocol === 'SHADOWSOCKS' && defaultMethod ? { method: defaultMethod } : {}),
          ...(configFlow ? { flow: configFlow } : {}),
        },
        clientEmailFor(assignment.id),
      ),
    ),
  };
}

function buildClient(
  protocol: string,
  credential: Record<string, unknown>,
  email: string,
): Record<string, unknown> {
  if (protocol === 'VMESS') {
    return { id: credential.uuid, alterId: Number(credential.alterId ?? 0), security: 'auto', email };
  }
  if (protocol === 'VLESS') {
    return {
      id: credential.uuid,
      email,
      // Vision flow is per-CLIENT in Xray. The link carries it, so the server
      // entry must match — a client authenticates against an entry without the
      // flow and then transfers no data at all.
      ...(credential.flow ? { flow: credential.flow } : {}),
    };
  }
  if (protocol === 'SHADOWSOCKS') {
    // The cipher is REQUIRED on each client — Xray rejects the config with
    // "unsupported cipher method:" (empty) if it is left at the inbound level.
    // `email` is what makes Xray emit `user>>>EMAIL>>>traffic>>>uplink`, i.e.
    // what makes per-user accounting possible at all.
    return { method: credential.method, password: credential.password, email };
  }
  // Trojan (the last protocol) — same per-client flow rule as VLESS.
  return {
    password: credential.password,
    email,
    ...(credential.flow ? { flow: credential.flow } : {}),
  };
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

// -----------------------------------------------------------------------------
// Process control
// -----------------------------------------------------------------------------

interface CaptureResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Run a helper binary and capture its output.
 *
 * Deliberately asynchronous: `spawnSync` blocks the whole worker for the
 * duration of the call, and a stats query that hangs would stall every other
 * job. It also has a habit of failing outright on Windows (EBUSY when another
 * instance of the same image is running, or when a security product has the
 * file open), which is precisely the case where a silent empty result used to
 * make traffic accounting stop with no explanation.
 */
function execCapture(cmd: string, args: string[], timeoutMs = 15_000): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: CaptureResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({
        ok: false,
        status: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish({ ok: false, status: null, stdout, stderr, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        status: null,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, status: code, stdout, stderr });
    });
  });
}

/**
 * Generate an x25519 keypair for a REALITY configuration.
 *
 * Runs the node's own binary, so the keys are exactly the shape this Xray build
 * expects and there is no second crypto dependency. Returns null (never throws)
 * when the binary is missing or the output cannot be parsed — the caller reports
 * that as a configuration error rather than persisting a half-generated config.
 */
export async function generateRealityKeypair(): Promise<{ privateKey: string; publicKey: string } | null> {
  const { exe } = getXrayPaths();
  if (!existsSync(exe)) return null;

  const result = await execCapture(exe, ['x25519'], 10_000);
  if (!result.ok) return null;
  return parseX25519Output(result.stdout);
}

/**
 * Ask the real binary whether it will accept this config, BEFORE it reaches the
 * live file.
 *
 * Xray does not skip an inbound it cannot build — it refuses to start at all, so
 * a single unsupported setting (Xray 26 removed the mKCP header, the HTTP/h2
 * transports and QUIC) takes every other configuration down with it. That is
 * exactly what happened on 2026-09-28: one mKCP configuration stopped the whole
 * node. Rendering is cheap and this test runs only when the hash changes, so the
 * cost is one process launch per configuration change.
 */
export async function validateRenderedConfig(
  config: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; failure: string }> {
  const { exe, dir } = getXrayPaths();
  if (!existsSync(exe)) return { ok: false, failure: 'the Xray binary was not found' };

  const probe = join(dir, '.vpanel-config-probe.json');
  try {
    writeFileSync(probe, JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    return { ok: false, failure: `could not write the probe file: ${String(error)}` };
  }

  const result = await execCapture(exe, ['run', '-test', '-c', probe], 20_000);
  try {
    unlinkSync(probe);
  } catch {
    /* non-fatal */
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (/Configuration OK/i.test(output) || (!/Failed to/i.test(output) && result.ok)) {
    return { ok: true };
  }

  // Surface Xray's own words — they name the exact setting that is wrong.
  const line =
    output.match(/Failed to start:[^\n]*/)?.[0] ??
    output.match(/Failed to build[^\n]*/)?.[0] ??
    output.match(/common\/errors:[^\n]*/)?.[0] ??
    'Xray rejected the configuration';
  return { ok: false, failure: line.replace(/\s+/g, ' ').trim().slice(0, 300) };
}

/** Last transport error, so the UI/worker can explain an empty result. */
let lastStatsError: string | null = null;

export function getLastStatsError(): string | null {
  return lastStatsError;
}

async function isXrayRunning(): Promise<boolean> {
  const pid = readState().pid;
  if (pid && isProcessAlive(pid)) return true;

  // Fall back to looking for the process by name.
  const result = await execCapture('tasklist', ['/FI', 'IMAGENAME eq xray.exe', '/FO', 'CSV', '/NH'], 8_000);
  return result.stdout.toLowerCase().includes('xray.exe');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop Xray and wait until it is genuinely gone.
 *
 * Firing `taskkill` is not stopping. The old process may still be holding the
 * port for a moment after the kill is issued, and starting a replacement in
 * that window fails with a bind error — which looks exactly like "the config is
 * broken" when in fact the only problem was a race. Verified here, because a
 * supervisor that cannot reliably stop its child cannot reliably start one
 * either.
 */
async function stopXray(): Promise<void> {
  const { pid } = readState();
  if (pid) {
    await execCapture('taskkill', ['/PID', String(pid), '/T', '/F'], 10_000);
  }
  // Also sweep by name in case the pid was lost or belongs to another process
  // tree that started Xray.
  await execCapture('taskkill', ['/IM', 'xray.exe', '/F'], 10_000);

  // Wait for it to actually exit. Bounded so a stuck kill cannot hang the
  // reconcile forever; if it times out the caller reports the failure honestly.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await isXrayRunning())) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

interface StartOutcome {
  pid: number | null;
  /** True only once the process was observed alive after the grace period. */
  running: boolean;
  /** Xray's own explanation when it refused to start. */
  failure: string | null;
}

/**
 * Start Xray and *verify it survived*.
 *
 * Spawning is not starting. `spawn` succeeds for a process that exits a
 * millisecond later, which is how the supervisor came to log "Xray started"
 * every 15 seconds while `tasklist` showed no Xray at all and every port was
 * dead. The panel was reporting success on a node that had been down for
 * hours — the single most misleading state it could be in.
 *
 * So: spawn, wait a bounded grace period, then check liveness. If it died,
 * read its output for the reason and report that instead.
 */
async function startXrayAndVerify(graceMs = 1_500): Promise<StartOutcome> {
  const paths = getXrayPaths();
  if (!existsSync(paths.exe)) return { pid: null, running: false, failure: 'xray.exe not found' };

  let stdout = '';
  let stderr = '';

  let child;
  try {
    child = spawn(paths.exe, ['run', '-c', paths.config], {
      cwd: paths.dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return { pid: null, running: false, failure: (error as Error).message };
  }

  // Capture just enough to explain a failure. Xray prints its banner and any
  // bind error in the first few lines, and exits.
  const collect = (chunk: Buffer) => {
    const text = chunk.toString();
    if (stdout.length < 8_000) stdout += text;
    if (stderr.length < 8_000) stderr += text;
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const pid = child.pid ?? null;

  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), graceMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
  });

  if (exitCode !== null) {
    // It exited inside the grace period: it never started.
    const failure = startupFailureLine(stdout + stderr) ?? `exited immediately (code ${exitCode})`;
    return { pid: null, running: false, failure };
  }

  // Still alive. Detach it so it outlives the worker's own process tree.
  try {
    child.unref();
  } catch {
    // Non-fatal.
  }

  return { pid, running: pid !== null && isProcessAlive(pid), failure: null };
}

// -----------------------------------------------------------------------------
// Reconcile
// -----------------------------------------------------------------------------

export interface SyncResult {
  enabled: boolean;
  changed: boolean;
  restarted: boolean;
  inbounds: number;
  ports: number[];
  skipped: string[];
  hash: string | null;
  message: string;
}

/**
 * Store the latest per-tunnel render failures so the tunnels page can explain
 * why an enabled row is not being served. Best-effort: a database hiccup must
 * never stop a reconcile.
 */
async function persistTunnelErrors(errors: Record<string, string>): Promise<void> {
  try {
    const rows = await prisma.tunnel.findMany({ select: { id: true, lastError: true } });
    const updates = rows.flatMap((row) => {
      const next = errors[row.id] ?? null;
      if (row.lastError === next) return [];
      return [
        prisma.tunnel.update({
          where: { id: row.id },
          data: { lastError: next },
        }),
      ];
    });

    if (updates.length > 0) await Promise.all(updates);
  } catch {
    // The tunnel still works; the explanation is simply one reconcile behind.
  }
}

/**
 * Reconcile the node with the database.
 *
 * Writes and restarts only when the rendered config differs from the one
 * currently applied, so a periodic call is cheap and does not bounce live
 * connections for no reason.
 */
export async function syncXray(options: { force?: boolean } = {}): Promise<SyncResult> {
  const env = getEnv();

  if (!isSupervisorEnabled()) {
    return {
      enabled: false,
      changed: false,
      restarted: false,
      inbounds: 0,
      ports: [],
      skipped: [],
      hash: null,
      message:
        env.XRAY_ENABLED !== 'true'
          ? 'Xray supervisor is disabled (set XRAY_ENABLED=true)'
          : `xray.exe not found in ${getXrayPaths().dir}`,
    };
  }

  const paths = getXrayPaths();

  /**
   * Single-writer guard.
   *
   * The panel and the worker are both writers to `config.json`: the worker on its
   * 15 s reconcile, and the panel on every configuration mutation (via
   * `triggerXraySync()`). Without this check the panel could reconcile from its
   * own — possibly stale — in-memory renderer while a worker was mid-write, which
   * is how "I fixed it but the node reverted" happens: the panel's `next start`
   * build can predate a source fix the worker (running `tsx`) already has.
   *
   * `mayWriteNodeConfig` says yes when we own the lock, or when nobody live does.
   * `force` is for the explicit `xray:sync` CLI, where an operator asking for a
   * sync by hand should not be silently ignored — but even then a live foreign
   * owner is reported rather than overwritten.
   */
  if (!options.force) {
    const verdict = mayWriteNodeConfig(paths.dir);
    if (!verdict.mayWrite && verdict.reason === 'held-by-another-live-process') {
      return {
        enabled: true,
        changed: false,
        restarted: false,
        inbounds: 0,
        ports: [],
        skipped: [],
        hash: null,
        message:
          `another ${verdict.holder.role} (pid ${verdict.holder.pid}) owns the node ` +
          `config — this process deferred the reconcile to it.`,
      };
    }
  }

  const previous = readState();

  // Only treat a port as "ours" while the node we recorded is still running and
  // its config is the one on disk. Otherwise a stale `appliedPorts` would let a
  // genuinely contested port through unprobed.
  const nodeRunning = await isXrayRunning();
  const alreadyHeld = nodeRunning ? previous.appliedPorts ?? [] : [];

  const rendered = await renderXrayConfig({ alreadyHeld });

  // Keep the tunnels page honest: an enabled tunnel that cannot be served (its
  // port is held by a third party, for example) gets a readable reason instead
  // of silently disappearing from the config.
  await persistTunnelErrors(rendered.tunnelErrors ?? {});

  // No active configurations: stop serving AND wipe the rendered inbounds.
  //
  // Leaving the previous config.json in place is exactly the "I deleted it but
  // it still works" complaint: the file still lists the revoked credentials, so
  // anyone who starts Xray by hand gets the old access back. Writing an empty
  // config means a manual start serves nothing.
  //
  // BUT: an empty render is indistinguishable from a transient read. On
  // 2026-09-28 a second, stale worker rendered from a momentarily-empty view of
  // the database and wiped config.json, taking every port down for ~12 minutes.
  // So an empty render is only applied once it has been confirmed on
  // consecutive ticks; until then the previous config stays in place and the
  // node keeps serving. `decideEmptyRender` owns that rule.
  if (!rendered.config) {
    const alreadyRunning = await isXrayRunning();
    const consecutiveEmptyRenders = (previous.emptyRenderCount ?? 0) + 1;

    const verdict = decideEmptyRender({
      consecutiveEmptyRenders,
      xrayRunning: alreadyRunning,
    });

    if (verdict.action === 'hold') {
      writeState({ ...previous, emptyRenderCount: consecutiveEmptyRenders });

      // Never downgrade a served config to a wipe on a single observation.
      // Reporting `changed: false` keeps the drift alert quiet for what is, by
      // assumption, a transient condition.
      return {
        enabled: true,
        changed: false,
        restarted: false,
        inbounds: rendered.inbounds,
        ports: rendered.ports,
        skipped: rendered.skipped,
        hash: previous.appliedHash ?? null,
        message: verdict.reason,
      };
    }

    mkdirSync(paths.dir, { recursive: true });
    const empty = {
      log: { loglevel: 'warning', access: 'none' },
      inbounds: [],
      outbounds: [{ protocol: 'freedom', tag: 'direct' }],
    };
    const emptyTemp = `${paths.config}.tmp`;
    writeFileSync(emptyTemp, JSON.stringify(empty, null, 2), 'utf8');
    renameSync(emptyTemp, paths.config);

    // Counters belong to the stopped process. Tunnel baselines are left in
    // place: `collectTunnelTraffic` treats a lower raw value as a fresh counter,
    // so it recovers on its own after a restart.
    resetTrafficSnapshot();

    const wasRunning = await isXrayRunning();
    if (wasRunning) await stopXray();

    writeState({
      appliedHash: undefined,
      appliedAt: new Date().toISOString(),
      appliedPorts: [],
      emptyRenderCount: consecutiveEmptyRenders,
    });

    return {
      enabled: true,
      changed: true,
      restarted: wasRunning,
      inbounds: 0,
      ports: [],
      skipped: rendered.skipped,
      hash: null,
      message: wasRunning
        ? `No active configurations - Xray stopped and config cleared (${verdict.reason})`
        : `No active configurations - config cleared (${verdict.reason})`,
    };
  }

  // A render with inbounds but no usable port, or no outbound at all, would make
  // Xray refuse to start and take every other port down with it. Keep the
  // previous working file instead and surface the problem.
  const shape = assertRenderIsApplicable(rendered.config);
  if (!shape.ok) {
    return {
      enabled: true,
      changed: false,
      restarted: false,
      inbounds: rendered.inbounds,
      ports: rendered.ports,
      skipped: rendered.skipped,
      hash: previous.appliedHash ?? null,
      message: `refused to apply an unusable render (${shape.reason}) — keeping the previous configuration`,
    };
  }

  const hash = hashOf(rendered.config);
  const running = await isXrayRunning();
  const upToDate = previous.appliedHash === hash && running;

  if (upToDate && !options.force) {
    return {
      enabled: true,
      changed: false,
      restarted: false,
      inbounds: rendered.inbounds,
      ports: rendered.ports,
      skipped: rendered.skipped,
      hash,
      message: 'already up to date',
    };
  }

  // Ask Xray itself before touching the live file. A configuration it refuses
  // would otherwise stop the WHOLE node (it does not skip a bad inbound), so a
  // rejected render is dropped and the previous config keeps serving.
  const validation = await validateRenderedConfig(rendered.config);
  if (!validation.ok) {
    return {
      enabled: true,
      changed: false,
      restarted: false,
      inbounds: rendered.inbounds,
      ports: rendered.ports,
      skipped: [
        ...rendered.skipped,
        `Xray REFUSED the rendered config, so it was NOT applied: ${validation.failure}`,
      ],
      hash: previous.appliedHash ?? null,
      message: `the rendered config was rejected by Xray and was not applied — ${validation.failure}`,
    };
  }

  mkdirSync(paths.dir, { recursive: true });
  const temp = `${paths.config}.tmp`;
  writeFileSync(temp, JSON.stringify(rendered.config, null, 2), 'utf8');
  renameSync(temp, paths.config);

  await stopXray();
  let outcome = await startXrayAndVerify();

  // A bind failure immediately after a stop is almost always the previous
  // process not having released the port yet, not a bad configuration. Retry
  // once before declaring the node broken — the alternative is a spurious
  // "FAILED to start" while a perfectly good config sits on disk.
  if (!outcome.running && outcome.failure !== null) {
    const bindRace = /bind|Only one usage of each socket address/i.test(outcome.failure);
    if (bindRace) {
      await stopXray();
      await new Promise((resolve) => setTimeout(resolve, 750));
      outcome = await startXrayAndVerify();
    }
  }

  // If it still failed but *something* is serving the port, the old process
  // survived. Report that honestly rather than claiming the node is down when
  // it is demonstrably still handling traffic.
  if (!outcome.running && (await isXrayRunning())) {
    writeState({
      appliedHash: hash,
      appliedAt: new Date().toISOString(),
      appliedPorts: rendered.ports,
      emptyRenderCount: 0,
    });
    return {
      enabled: true,
      changed: true,
      restarted: false,
      inbounds: rendered.inbounds,
      ports: rendered.ports,
      skipped: rendered.skipped,
      hash,
      message: 'config written; the previous Xray instance is still serving (restart pending)',
    };
  }

  // Xray refused to start. Report the truth, and try to recover.
  //
  // This is the state the panel used to call "Xray started": the process was
  // spawned, then died on a bind error a moment later, and every inbound went
  // with it. The panel showed a healthy node while nothing was being served.
  if (!outcome.running) {
    const failure = outcome.failure ?? 'Xray exited immediately after start';

    // Recover: Xray dies on the FIRST unbindable port, so if we can identify
    // it, drop that one configuration and retry. One bad row should cost the
    // operator that row, not the whole node.
    const port = portFromBindError(failure);
    if (port !== null) {
      const recovered = await retryWithoutPort(rendered.config, port);
      if (recovered) {
        const retryHash = hashOf(recovered.config);
        const retryOutcome = await startXrayAndVerify();

        if (retryOutcome.running) {
          writeState({
            pid: retryOutcome.pid ?? undefined,
            appliedHash: retryHash,
            appliedAt: new Date().toISOString(),
            appliedPorts: recovered.ports,
            emptyRenderCount: 0,
          });

          return {
            enabled: true,
            changed: true,
            restarted: true,
            inbounds: recovered.inbounds,
            ports: recovered.ports,
            skipped: [
              ...rendered.skipped,
              recovered.quarantined,
              `recovered: dropped port ${port} so the remaining ${recovered.inbounds} inbound(s) could start`,
            ],
            hash: retryHash,
            message: `Xray started after dropping port ${port} (${failure.slice(0, 120)})`,
          };
        }
      }
    }

    writeState({
      pid: undefined,
      appliedHash: hash,
      appliedAt: new Date().toISOString(),
      appliedPorts: [],
      emptyRenderCount: 0,
    });

    return {
      enabled: true,
      changed: true,
      restarted: false,
      inbounds: rendered.inbounds,
      ports: rendered.ports,
      skipped: rendered.skipped,
      hash,
      message: `Xray FAILED to start: ${failure.slice(0, 240)}`,
    };
  }

  writeState({
    pid: outcome.pid ?? undefined,
    appliedHash: hash,
    appliedAt: new Date().toISOString(),
    appliedPorts: rendered.ports,
    emptyRenderCount: 0,
  });

  return {
    enabled: true,
    changed: true,
    restarted: true,
    inbounds: rendered.inbounds,
    ports: rendered.ports,
    skipped: rendered.skipped,
    hash,
    message: running ? 'config changed - Xray restarted' : 'Xray started',
  };
}

/**
 * Drop every inbound bound to `port` and return the config without them.
 *
 * Used only as recovery after Xray has already failed to start, so it trades
 * completeness for availability: some configurations serving beats none.
 */
async function retryWithoutPort(
  config: Record<string, unknown>,
  port: number,
): Promise<{ config: Record<string, unknown>; inbounds: number; ports: number[]; quarantined: string } | null> {
  const inbounds = (config.inbounds ?? []) as XrayInbound[];
  const kept = inbounds.filter((inbound) => Number(inbound.port) !== port);

  if (kept.length === inbounds.length || kept.length === 0) return null;

  const dropped = inbounds.filter((inbound) => Number(inbound.port) === port);

  // Identify the configuration behind the dropped tag, so the operator sees a
  // name rather than a tag.
  const tags = dropped.map((inbound) => inbound.tag).filter(Boolean) as string[];
  let quarantined = `dropped inbound(s) on port ${port} (${tags.join(', ')})`;

  const all = await prisma.configuration.findMany({
    select: { id: true, name: true, params: true, server: { select: { port: true } } },
  });
  const names = all
    .filter((row) => {
      const candidate = Number((row.params as Record<string, unknown> | null)?.port ?? row.server.port);
      return candidate === port;
    })
    .map((row) => row.name);

  // Tunnels are not configurations; without this lookup the recovery message
  // would say "dropped port 8443" with no clue which tunnel disappeared.
  const tunnels = await prisma.tunnel.findMany({
    where: { listenPort: port },
    select: { name: true },
  });
  names.push(...tunnels.map((tunnel) => `tunnel ${tunnel.name}`));

  if (names.length > 0) quarantined = `dropped port ${port} — ${names.join(', ')}`;

  const ports = kept
    .map((inbound) => Number(inbound.port))
    .filter((value) => Number.isInteger(value) && value !== Number(getEnv().XRAY_API_PORT));

  return {
    config: { ...config, inbounds: kept },
    inbounds: kept.length - 1, // exclude the loopback stats inbound
    ports,
    quarantined,
  };
}

// -----------------------------------------------------------------------------
// On-demand sync
// -----------------------------------------------------------------------------

/**
 * Fire-and-forget reconcile, used right after a configuration changes.
 *
 * The periodic worker would pick the change up within its interval anyway, but
 * a user who just clicked "Create" should not have to wait for a timer — and
 * "I deleted it but it still works" is exactly the bug this prevents.
 *
 * Failures are swallowed on purpose: a sync problem must never fail the API call
 * that triggered it. The worker will retry.
 */
let pending: Promise<unknown> | null = null;

export function triggerXraySync(): void {
  const env = getEnv();
  if (env.XRAY_ENABLED !== 'true' || env.XRAY_AUTO_SYNC !== 'true') return;
  if (pending) return;

  pending = syncXray()
    .catch(() => undefined)
    .finally(() => {
      pending = null;
    });
}

// -----------------------------------------------------------------------------
// Traffic accounting
// -----------------------------------------------------------------------------

interface StatEntry {
  name?: string;
  value?: number | string;
}

/** Cumulative per-user counters, keyed by client email. */
export async function queryUserStats(): Promise<Map<string, { up: bigint; down: bigint }>> {
  const result = new Map<string, { up: bigint; down: bigint }>();
  if (!isSupervisorEnabled()) return result;

  const paths = getXrayPaths();
  const server = `127.0.0.1:${getEnv().XRAY_API_PORT}`;

  const query = await execCapture(
    paths.exe,
    ['api', 'statsquery', `--server=${server}`, '-pattern', 'user>>>'],
    15_000,
  );

  if (!query.ok || !query.stdout) {
    // Surface the reason instead of returning an empty map. A silent empty
    // result here is indistinguishable from "no traffic", which is how
    // accounting can stop for days without anyone noticing.
    lastStatsError = query.error ?? query.stderr.trim() ?? `statsquery exited with ${query.status}`;
    return result;
  }

  lastStatsError = null;

  let parsed: { stat?: StatEntry[] };
  try {
    parsed = JSON.parse(query.stdout) as { stat?: StatEntry[] };
  } catch {
    lastStatsError = 'statsquery returned malformed JSON';
    return result;
  }

  for (const entry of parsed.stat ?? []) {
    if (!entry.name) continue;

    // user>>>vp-<assignmentId>>>traffic>>>uplink
    const match = /^user>>>(.+?)>>>traffic>>>(uplink|downlink)$/.exec(entry.name);
    if (!match) continue;

    const [, email, direction] = match as unknown as [string, string, 'uplink' | 'downlink'];
    const value = BigInt(String(entry.value ?? '0'));

    const current = result.get(email) ?? { up: 0n, down: 0n };
    if (direction === 'uplink') current.up = value;
    else current.down = value;
    result.set(email, current);
  }

  return result;
}

/**
 * Cumulative counters for tunnel inbounds, keyed by their tag.
 *
 * Xray names inbound counters `inbound>>>TAG>>>traffic>>>uplink` and only
 * produces them because the rendered config sets
 * `policy.system.statsInboundUplink/Downlink`. The same `statsquery` call
 * returns every inbound, so one process spawn covers all tunnels.
 */
export async function queryInboundStats(): Promise<Map<string, { up: bigint; down: bigint }>> {
  const result = new Map<string, { up: bigint; down: bigint }>();
  if (!isSupervisorEnabled()) return result;

  const paths = getXrayPaths();
  const server = `127.0.0.1:${getEnv().XRAY_API_PORT}`;

  const query = await execCapture(
    paths.exe,
    ['api', 'statsquery', `--server=${server}`, '-pattern', 'inbound>>>'],
    15_000,
  );

  if (!query.ok || !query.stdout) {
    lastStatsError = query.error ?? query.stderr.trim() ?? `statsquery exited with ${query.status}`;
    return result;
  }

  // Do not clear `lastStatsError` here: `queryUserStats` runs first and may have
  // failed. A successful inbound query must not hide that failure.

  let parsed: { stat?: StatEntry[] };
  try {
    parsed = JSON.parse(query.stdout) as { stat?: StatEntry[] };
  } catch {
    lastStatsError = 'statsquery returned malformed JSON';
    return result;
  }

  for (const entry of parsed.stat ?? []) {
    if (!entry.name) continue;

    // inbound>>>tunnel-<id>>>traffic>>>uplink
    const match = /^inbound>>>(tunnel-[^>]+)>>>traffic>>>(uplink|downlink)$/.exec(entry.name);
    if (!match) continue;

    const [, tag, direction] = match as unknown as [string, string, 'uplink' | 'downlink'];
    const value = BigInt(String(entry.value ?? '0'));

    const current = result.get(tag) ?? { up: 0n, down: 0n };
    if (direction === 'uplink') current.up = value;
    else current.down = value;
    result.set(tag, current);
  }

  return result;
}

export interface XrayTrafficSample {
  clientEmail: string;
  /** Total bytes for the CURRENT window — not a delta. See below. */
  uploadBytes: bigint;
  downloadBytes: bigint;
}

/**
 * Per-client accounting state.
 *
 * `raw` is the node's counter, which counts from process start and resets on
 * restart. `base` is the raw value that corresponds to "zero bytes in the
 * current window" — deliberately allowed to go negative after a restart so the
 * bytes already recorded for this window are not lost.
 */
export interface ClientBaseline {
  rawUp: string;
  rawDown: string;
  baseUp: string;
  baseDown: string;
  windowKey: string;
}

/**
 * Turn the node's cumulative counters into **per-window totals**.
 *
 * Pure and exported so the arithmetic can be tested without a node, a database
 * or a clock.
 *
 * The baseline is the raw counter value that means "zero bytes in this window".
 * Three transitions matter:
 *
 *   first sighting  -> 0. The node's counter is cumulative from process start,
 *                      so a client we have never recorded owes all of it. Using
 *                      the *current* value here would silently discard
 *                      everything that arrived before we first looked, which is
 *                      exactly what happens when a client only appears in the
 *                      stats after its first connection.
 *   window rollover -> the previous raw value, so the bytes that arrived between
 *                      the last collection and the rollover are attributed to
 *                      the new window instead of being dropped.
 *   node restart    -> negative, so `raw - base` still equals everything already
 *                      recorded for this window.
 */
export function computeWindowTotals(
  current: Map<string, { up: bigint; down: bigint }>,
  previous: Record<string, ClientBaseline>,
  windowKey: string,
): { samples: XrayTrafficSample[]; snapshot: Record<string, ClientBaseline> } {
  const samples: XrayTrafficSample[] = [];
  const snapshot: Record<string, ClientBaseline> = {};

  for (const [email, counters] of current) {
    const before = previous[email];

    let baseUp: bigint;
    let baseDown: bigint;

    if (!before) {
      // Never seen: everything the node has counted for this client is owed.
      baseUp = 0n;
      baseDown = 0n;
    } else {
      const rawUp = BigInt(before.rawUp);
      const rawDown = BigInt(before.rawDown);
      const prevBaseUp = BigInt(before.baseUp);
      const prevBaseDown = BigInt(before.baseDown);

      const restarted = counters.up < rawUp || counters.down < rawDown;

      if (before.windowKey !== windowKey) {
        // New window. Start from the last observed value so nothing that
        // arrived since is lost — unless the node restarted, in which case its
        // counter genuinely began again at zero.
        baseUp = restarted ? 0n : rawUp;
        baseDown = restarted ? 0n : rawDown;
      } else if (restarted) {
        // The node restarted, so its counter went back to zero. The new
        // counter's zero point corresponds to everything already recorded for
        // this window, which makes the baseline negative:
        //   total = raw - base = raw - (-recorded) = raw + recorded
        baseUp = -(rawUp - prevBaseUp);
        baseDown = -(rawDown - prevBaseDown);
      } else {
        baseUp = prevBaseUp;
        baseDown = prevBaseDown;
      }
    }

    const uploadBytes = counters.up - baseUp;
    const downloadBytes = counters.down - baseDown;

    snapshot[email] = {
      rawUp: counters.up.toString(),
      rawDown: counters.down.toString(),
      baseUp: baseUp.toString(),
      baseDown: baseDown.toString(),
      windowKey,
    };

    if (uploadBytes > 0n || downloadBytes > 0n) {
      samples.push({ clientEmail: email, uploadBytes, downloadBytes });
    }
  }

  return { samples, snapshot };
}

/**
 * Read the node's counters and convert them to per-window totals.
 *
 * The window-total contract matters and is easy to get wrong.
 * `recordTrafficSamples` expects the running total *for the window*: it looks
 * up the ledger row for `(server, user, config, windowKey)` and applies only
 * the difference, which is what makes collection idempotent. Feeding it deltas
 * instead makes the ledger net the deltas against each other, so every
 * collection after the first within the same window is silently swallowed.
 *
 * Since the reconcile worker runs every 15s and a window is one minute, that
 * would discard three quarters of all traffic.
 */
export async function collectXrayTraffic(): Promise<XrayTrafficSample[]> {
  const paths = getXrayPaths();
  const current = await queryUserStats();
  if (current.size === 0) return [];

  let previous: Record<string, ClientBaseline> = {};
  if (existsSync(paths.stats)) {
    try {
      previous = JSON.parse(readFileSync(paths.stats, 'utf8')) as typeof previous;
    } catch {
      previous = {};
    }
  }

  const windowKey = new Date().toISOString().slice(0, 16);
  const { samples, snapshot } = computeWindowTotals(current, previous, windowKey);

  try {
    const temp = `${paths.stats}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot), 'utf8');
    renameSync(temp, paths.stats);
  } catch {
    // Non-fatal: the next pass simply re-counts from the last good snapshot.
  }

  return samples;
}

interface TunnelBaseline {
  rawUp: string;
  rawDown: string;
}

/**
 * Add the delta since the previous pass to each tunnel's stored counters.
 *
 * Xray counters reset when the process restarts. When the new raw value is
 * lower than the previous one, the counter genuinely began again at zero, so the
 * new value *is* the delta. That is the same rule the per-user collector
 * applies, kept simpler here because tunnels only need a lifetime total rather
 * than a windowed ledger.
 */
export async function collectTunnelTraffic(): Promise<{ updated: number; bytes: bigint }> {
  const paths = getXrayPaths();
  const current = await queryInboundStats();
  if (current.size === 0) return { updated: 0, bytes: 0n };

  let previous: Record<string, TunnelBaseline> = {};
  if (existsSync(paths.tunnelStats)) {
    try {
      previous = JSON.parse(readFileSync(paths.tunnelStats, 'utf8')) as typeof previous;
    } catch {
      previous = {};
    }
  }

  const rows = await prisma.tunnel.findMany({ select: { id: true } });
  const known = new Set(rows.map((row) => `tunnel-${row.id}`));

  const snapshot: Record<string, TunnelBaseline> = {};
  let updated = 0;
  let bytes = 0n;

  for (const [tag, counters] of current) {
    if (!known.has(tag)) continue;

    const before = previous[tag];
    let deltaUp = counters.up;
    let deltaDown = counters.down;

    if (before) {
      const previousUp = BigInt(before.rawUp);
      const previousDown = BigInt(before.rawDown);
      deltaUp = counters.up >= previousUp ? counters.up - previousUp : counters.up;
      deltaDown = counters.down >= previousDown ? counters.down - previousDown : counters.down;
    }

    snapshot[tag] = { rawUp: counters.up.toString(), rawDown: counters.down.toString() };

    if (deltaUp === 0n && deltaDown === 0n) continue;

    try {
      await prisma.tunnel.update({
        where: { id: tag.slice('tunnel-'.length) },
        data: {
          trafficUpBytes: { increment: deltaUp },
          trafficDownBytes: { increment: deltaDown },
        },
      });
      updated += 1;
      bytes += deltaUp + deltaDown;
    } catch {
      // Deleted between the query and the update — drop the sample.
    }
  }

  // Keep the baseline for a known tunnel that happens to have no counter right
  // now (no traffic since a restart). Dropping it would make the first later
  // sample look like a brand-new counter, which is still safe, but keeping it
  // makes a quiet tunnel resume exactly where it left off.
  for (const [tag, baseline] of Object.entries(previous)) {
    if (known.has(tag) && !(tag in snapshot)) snapshot[tag] = baseline;
  }

  try {
    const temp = `${paths.tunnelStats}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot), 'utf8');
    renameSync(temp, paths.tunnelStats);
  } catch {
    // Non-fatal: the next pass re-counts from the last good snapshot.
  }

  return { updated, bytes };
}

/** Reset the traffic snapshot — call after Xray is (re)started by hand. */
export function resetTrafficSnapshot(): void {
  const { stats } = getXrayPaths();
  try {
    if (existsSync(stats)) unlinkSync(stats);
  } catch {
    // ignore
  }
}



// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

export interface XrayRuntime {
  enabled: boolean;
  running: boolean;
  appliedPorts: number[];
  appliedAt: string | null;
}

/**
 * Cheap runtime snapshot for list pages.
 *
 * Deliberately does NOT call `renderXrayConfig()`: that probes every port and is
 * far too expensive to run on a page load. The applied ports recorded by the
 * last successful reconcile are enough to tell "active" from "waiting for
 * sync".
 */
export async function getXrayRuntime(): Promise<XrayRuntime> {
  const state = readState();
  return {
    enabled: getEnv().XRAY_ENABLED === 'true',
    running: await isXrayRunning(),
    appliedPorts: state.appliedPorts ?? [],
    appliedAt: state.appliedAt ?? null,
  };
}

export interface XrayStatus {
  enabled: boolean;
  installed: boolean;
  running: boolean;
  inbounds: number;
  ports: number[];
  appliedAt: string | null;
  drifted: boolean;
  dir: string;
  /** Why the last stats query failed, if it did. Null when healthy. */
  statsError: string | null;
}

export async function getXrayStatus(): Promise<XrayStatus> {
  const paths = getXrayPaths();
  const state = readState();
  const rendered = isSupervisorEnabled()
    ? await renderXrayConfig({ alreadyHeld: state.appliedPorts ?? [] })
    : null;
  const hash = rendered?.config ? hashOf(rendered.config) : null;

  return {
    enabled: getEnv().XRAY_ENABLED === 'true',
    installed: existsSync(paths.exe),
    running: await isXrayRunning(),
    inbounds: rendered?.inbounds ?? 0,
    ports: rendered?.ports ?? [],
    appliedAt: state.appliedAt ?? null,
    drifted: hash !== null && state.appliedHash !== hash,
    dir: paths.dir,
    statsError: lastStatsError,
  };
}

export type { Prisma };

/**
 * Ports Xray can never bind, and why.
 *
 * Xray aborts the ENTIRE process when a single inbound cannot bind — it does not
 * drop that one inbound and keep serving the rest. So one unusable port does not
 * cost you one configuration; it costs you every configuration, and the log line
 * the operator sees is "Failed to start". That is exactly the report:
 *
 *   "when I open another config on port 443 and after another ports I created
 *    it getting closed ... the other ports get closed and 445 is now open but
 *    there is no connection"
 *
 * Two separate traps hide in that sentence:
 *
 *   1. Port 445 is served by the Windows SMB stack itself (System, PID 4). It
 *      is *always* listening, so `netstat` shows the port open and a client
 *      connects successfully — to SMB, not to the proxy. There is no way to
 *      serve a proxy there without disabling file sharing.
 *
 *   2. Port 443 was already claimed by another configuration in the panel, so
 *      the two silently competed for it.
 *
 * This module is deliberately pure: it answers "would Xray be able to bind
 * this?" from a static table plus a caller-supplied probe. That keeps it
 * unit-testable and keeps the OS calls in the service layer.
 */

/** A port that is permanently unusable for an inbound on this platform. */
export interface PortConflict {
  port: number;
  /** Short reason, suitable for a table cell. */
  reason: string;
  /** What the operator should do about it. */
  fix: string;
  /** True when no amount of retrying will help. */
  permanent: boolean;
}

/**
 * Ports the Windows network stack reserves for itself.
 *
 * `netsh int ipv4 show excludedportrange protocol=tcp` on a stock Windows 11
 * box also lists Hyper-V/WSL dynamic reservations, but the fixed ones below are
 * the ones worth hard-coding: they are present on every install and, critically,
 * they are the ones a proxy operator is most likely to pick by accident because
 * they look like ordinary high ports.
 */
const RESERVED_PORTS = new Map<number, string>([
  [135, 'Windows RPC endpoint mapper'],
  [137, 'NetBIOS name service'],
  [138, 'NetBIOS datagram service'],
  [139, 'NetBIOS session service'],
  [445, 'Windows SMB file sharing'],
  [1900, 'SSDP / UPnP discovery'],
  [3702, 'WS-Discovery'],
  [5040, 'Windows connected-devices platform'],
  [5357, 'WSDAPI / network discovery'],
  [5432, 'PostgreSQL (used by this panel)'],
  [5985, 'WinRM HTTP listener'],
  [5986, 'WinRM HTTPS listener'],
  [7680, 'Windows Delivery Optimization'],
  [47001, 'WinRM management endpoint'],
]);

/**
 * Ports that are technically bindable but are a bad idea for a proxy.
 *
 * Not fatal — reported as a warning so an operator who knows what they are
 * doing can proceed. These either collide with a service they are likely to be
 * running (this panel itself), or are so commonly blocked by upstream networks
 * that a "working" configuration would still look broken to the client.
 */
const DISCOURAGED_PORTS = new Map<number, string>([
  [80, 'commonly intercepted by ISP transparent proxies over plain HTTP'],
  [443, 'commonly intercepted by ISP transparent proxies; a panel-managed inbound is better on a high port with TLS'],
  [3000, 'the panel dev server default'],
  [10085, "the panel's own Xray stats API"],
]);

/**
 * Static conflict check — no OS calls, fully unit-testable.
 *
 * Returns null when the port is fine as far as this table knows. The caller
 * still has to probe the live system, because a *third-party* process holding
 * the port cannot be predicted from a table.
 */
export function staticPortConflict(port: number): PortConflict | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      port,
      reason: `${port} is not a valid TCP port number`,
      fix: 'Use a port between 1 and 65535',
      permanent: true,
    };
  }

  const reserved = RESERVED_PORTS.get(port);
  if (reserved) {
    return {
      port,
      reason: `reserved for ${reserved}`,
      fix:
        port === 445
          ? 'Windows always listens on 445 for file sharing and cannot release it — pick a high port such as 8443, 2053 or 2087'
          : 'Pick a different port; this one is owned by Windows itself',
      permanent: true,
    };
  }

  return null;
}

/** Is this port merely a bad idea, rather than impossible? */
export function discouragedPortReason(port: number): string | null {
  return DISCOURAGED_PORTS.get(port) ?? null;
}

/**
 * A live probe result: the port is held by *something other than us*.
 */
export interface PortProbe {
  /** True when a bind attempt succeeded (the port is free). */
  bindable: boolean;
  /** Human-readable detail when `bindable` is false. */
  detail?: string;
}

/**
 * Turn a static conflict or a failed probe into the message the operator reads
 * in the "skipped configurations" list.
 *
 * Kept next to the tables so the wording stays consistent with the reasons.
 */
export function describePortConflict(
  configName: string,
  conflict: PortConflict,
): string {
  return `${configName} (port ${conflict.port} ${conflict.reason} — ${conflict.fix})`;
}

/**
 * Parse Xray's own startup error to find which port killed it.
 *
 * Xray exits with a bind error naming the address. Recovering the port from the
 * message lets the supervisor quarantine exactly the offender and bring the rest
 * up, instead of backing off forever on a config that can never work.
 */
export function portFromBindError(message: string): number | null {
  // "failed to listen TCP on 445", "failed to listen on address: 0.0.0.0:445",
  // "listen tcp 0.0.0.0:445: bind: ..." — any of these forms.
  const addressMatch = message.match(/listen (?:on address: )?[\d.]*:(\d{1,5})\b/);
  if (addressMatch?.[1]) return Number(addressMatch[1]);

  const tcpMatch = message.match(/failed to listen TCP on (\d{1,5})\b/);
  if (tcpMatch?.[1]) return Number(tcpMatch[1]);

  const tagMatch = message.match(/failed to build inbound config with tag (\S+)/);
  if (tagMatch?.[1]) return null;

  return null;
}

/**
 * Parse the inbound tag Xray reports, if it names one.
 *
 * The bind error mentions the port but not the tag; other startup failures
 * (a stale `allowInsecure`, a duplicate tag) name the tag instead. Knowing
 * which gives a much better skipped-list entry than "Failed to start".
 */
export function tagFromXrayError(message: string): string | null {
  const match = message.match(/with tag (\S+)/);
  return match?.[1] ?? null;
}

/**
 * Extract the single most useful line from Xray's startup output.
 *
 * Xray writes a banner, then deprecation warnings, then `Failed to start: ...`.
 * The operator needs the last one only.
 */
export function startupFailureLine(output: string): string | null {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.includes('Failed to start')) {
      return line.replace(/^.*?Failed to start:\s*/, '').trim();
    }
  }
  return null;
}

/**
 * The ports the wizard offers, in the order an operator is most likely to want.
 *
 * 443 first because it is what clients expect and what most networks allow
 * through. The rest are the ports the proxy community has found to be rarely
 * blocked. Every entry is a port this panel can actually bind — see the
 * reserved table above.
 */
export const SUGGESTED_PORTS = [443, 8443, 2053, 2083, 2087, 2096, 444, 8080] as const;

/**
 * Pick a port for a new configuration.
 *
 * The wizard used to pre-fill the *server's* port, which is 443 — so the second
 * configuration an operator created always arrived with an already-occupied
 * port and was rejected. It looked like "choosing VLESS prevents me from
 * creating", but the protocol had nothing to do with it: the form simply handed
 * back a port it had already given away.
 *
 * So: offer the first preferred port that is both bindable and unclaimed, and
 * only fall back to scanning upward when every suggestion is taken.
 */
export function suggestPort(occupied: Iterable<number>): number {
  const taken = new Set(occupied);

  for (const candidate of SUGGESTED_PORTS) {
    if (!taken.has(candidate) && staticPortConflict(candidate) === null) return candidate;
  }

  // Every suggestion is in use — walk up from 10000, skipping anything Windows
  // owns and anything already claimed.
  for (let candidate = 10_000; candidate <= 65_535; candidate += 1) {
    if (taken.has(candidate)) continue;
    if (staticPortConflict(candidate) !== null) continue;
    return candidate;
  }

  return 0;
}

/**
 * Every port currently claimed by an ACTIVE configuration.
 *
 * Accepts the raw `params` blobs plus the server default, because a
 * configuration may inherit its port rather than storing one.
 */
export function claimedPorts(
  configs: Array<{ params?: unknown; server?: { port?: number } | null }>,
): number[] {
  const ports = new Set<number>();

  for (const config of configs) {
    const params = (config.params ?? {}) as Record<string, unknown>;
    const port = Number(params.port ?? config.server?.port);
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }

  return [...ports].sort((a, b) => a - b);
}

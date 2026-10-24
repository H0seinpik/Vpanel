/**
 * Port sharing — several configurations behind one public port.
 *
 * The problem this solves: an operator wants many configurations on 443, but a
 * TCP port can only be bound by one process at a time. "Many listeners on 443"
 * is not a thing the OS will ever allow, and no amount of application code
 * changes that.
 *
 * Xray's answer is `fallbacks`. ONE inbound binds 443 and reads the first packet
 * from each connection; traffic whose leading bytes match a configured `path` is
 * forwarded to a separate loopback inbound that handles it. The loopback
 * inbounds each have their own clients and emails, so per-user traffic
 * accounting and per-configuration ceilings keep working exactly as before.
 *
 * The shape this module produces:
 *
 *   public 0.0.0.0:443   VLESS + TLS   (tagless — required for fallbacks)
 *      ├─ path /vp-a  →  127.0.0.1:10001  VLESS  clients=[A]
 *      ├─ path /vp-b  →  127.0.0.1:10002  VLESS  clients=[B]
 *      ├─ path /vp-c  →  127.0.0.1:10003  VLESS  clients=[C]
 *      └─ (no match)  →  blackhole         (probes get nothing useful)
 *
 * Constraints worth knowing, because they cannot be engineered away:
 *
 *   - Only VLESS and Trojan support fallbacks. A VMess configuration cannot
 *     join a shared port; it would accept the port and then carry no traffic.
 *   - The public inbound must carry no `tag`. Xray rejects a fallback entry
 *     whose parent is tagged (`fallback can only be used in tagless inbound`),
 *     so the public listener is anonymous and the loopback inbounds hold the
 *     real tags.
 *   - The public inbound must use TLS. Without it, Xray cannot tell a proxy
 *     client from an ordinary HTTP request by path.
 *
 * This module is pure so the routing decisions can be unit-tested without a
 * database or a node.
 */

/** A configuration that wants to be served on a shared port. */
export interface ShareCandidate {
  /** Configuration id — used to derive a stable internal port and path. */
  id: string;
  name: string;
  protocol: string;
  security: string;
  network: string;
  path: string | null;
}

/** Why a configuration cannot join a shared port. */
export interface ShareRejection {
  name: string;
  reason: string;
  fix: string;
}

/** The loopback port range used for each member of a shared port. */
export const SHARE_INTERNAL_PORT_BASE = 20_000;

/**
 * Derive a deterministic loopback port for a shared configuration.
 *
 * Deterministic on purpose: the same configuration always gets the same
 * internal port, so a reconcile that changes nothing does not shuffle ports and
 * bounce every connection. Derived from the id so it is stable across restarts
 * and across processes.
 */
export function internalPortFor(configId: string, index: number): number {
  // A short hash of the id keeps two configurations from colliding even if the
  // caller passes a stale index.
  let hash = 0;
  for (let i = 0; i < configId.length; i += 1) {
    hash = (hash * 31 + configId.charCodeAt(i)) % 997;
  }
  return SHARE_INTERNAL_PORT_BASE + (hash % 900) + index * 1000;
}

/**
 * Derive a unique fallback path for a configuration.
 *
 * Must start with `/` and be unique within the shared port — two configurations
 * with the same path would make one of them unreachable with no error anywhere.
 */
export function sharePathFor(configId: string): string {
  const slug = configId.replace(/[^a-zA-Z0-9]/g, '').slice(-10);
  return `/vp-${slug}`;
}

/** Normalise a path so `/a`, `a` and `/a/` compare equal. */
function normalisePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  const withLead = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLead.replace(/\/+$/, '') || '/';
}

/**
 * Can this configuration be served on a shared port at all?
 *
 * Returns null when it can, or the reason it cannot. The reasons are surfaced to
 * the operator rather than silently dropping the configuration — a silently
 * dropped config is exactly the "my port is open but nothing connects" report.
 */
export function shareIneligible(candidate: ShareCandidate): ShareRejection | null {
  const protocol = candidate.protocol.toUpperCase();

  if (protocol !== 'VLESS' && protocol !== 'TROJAN') {
    return {
      name: candidate.name,
      reason: `${protocol} cannot share a port`,
      fix:
        `Only VLESS and Trojan support port sharing, and only VLESS can route by path. ` +
        `Recreate "${candidate.name}" as VLESS to put it on the shared port, or give it its own port.`,
    };
  }

  // REALITY cannot share a port: fallback routing needs a real TLS certificate
  // the shared listener can present, and REALITY has none — its clients
  // authenticate with an x25519 key carried in the link instead. That absence is
  // exactly why every app connects to it without a client-side tweak, so give it
  // its own port rather than pretending it can join.
  if (candidate.security === 'reality') {
    return {
      name: candidate.name,
      reason: 'REALITY cannot share a port',
      fix:
        `REALITY has no certificate for a shared listener to present, so give it its own ` +
        `port — or, to put another customer on the SAME port, add a user to it instead: ` +
        `every user gets their own link from that one port.`,
    };
  }

  if (candidate.security !== 'tls') {
    return {
      name: candidate.name,
      reason: 'needs TLS to share a port',
      fix:
        `Set security to "tls" so the shared listener can tell your clients apart from ` +
        `ordinary web traffic. Without it the port cannot share.`,
    };
  }

  // Sharing routes on the request path, and only the transports below actually
  // match a fallback when the request arrives. MEASURED with a real client per
  // transport (`.vpanel/which-transports-can-share.ts`): `ws` and `httpupgrade`
  // route correctly; `xhttp` and `grpc` never match a fallback, fall through to
  // the default destination, and carry no traffic — even though both accept a
  // path setting. A configuration in that state looks perfectly healthy and is
  // unreachable, so it is refused here rather than created.
  const network = candidate.network.toLowerCase();
  if (network !== 'ws' && network !== 'httpupgrade') {
    const pathless = network !== 'xhttp' && network !== 'grpc';
    return {
      name: candidate.name,
      reason: pathless
        ? `the "${network}" transport has no path to route on`
        : `the "${network}" transport cannot be reached through a shared port`,
      fix: pathless
        ? 'Use the "ws" (WebSocket) transport for a shared port.'
        : `"${network}" works on its own port but cannot be shared — the request never ` +
          `reaches the right fallback. Use "ws" to share this port, or give this ` +
          `configuration its own port.`,
    };
  }

  return null;
}

export interface SharePlan {
  /** Configurations that will be served on the shared port, in order. */
  members: Array<ShareCandidate & { internalPort: number; path: string }>;
  /** Configurations that cannot join, with the reason. */
  rejected: ShareRejection[];
}

/**
 * Plan how a set of candidates shares one port.
 *
 * Assigns each member a unique path and a loopback port. Anything ineligible is
 * reported rather than dropped, so the operator always learns why a
 * configuration is not being served.
 */
export function planPortSharing(candidates: ShareCandidate[]): SharePlan {
  const members: SharePlan['members'] = [];
  const rejected: ShareRejection[] = [];
  const usedPaths = new Set<string>();

  candidates.forEach((candidate, index) => {
    const ineligible = shareIneligible(candidate);
    if (ineligible) {
      rejected.push(ineligible);
      return;
    }

    // Prefer the operator's own path so existing client links keep working;
    // fall back to a derived one when they have not chosen.
    let path = normalisePath(candidate.path ?? '') || sharePathFor(candidate.id);

    // A duplicate path would make one configuration unreachable with no error
    // anywhere, so disambiguate rather than accept the collision.
    if (usedPaths.has(path)) {
      let suffix = 2;
      while (usedPaths.has(`${path}-${suffix}`)) suffix += 1;
      path = `${path}-${suffix}`;
    }
    usedPaths.add(path);

    members.push({
      ...candidate,
      path,
      internalPort: internalPortFor(candidate.id, index),
    });
  });

  return { members, rejected };
}

/**
 * Should these configurations share one port, or does each need its own?
 *
 * Sharing only makes sense when more than one configuration wants the SAME
 * port. A single configuration on a port keeps the simple direct layout — going
 * through a fallback for one config would add a hop for no benefit and would
 * make its share link depend on a path that nothing else uses.
 */
export function resolvePortLayout(
  candidates: ShareCandidate[],
): { mode: 'shared' | 'direct'; plan: SharePlan } {
  const plan = planPortSharing(candidates);
  return {
    mode: plan.members.length > 1 ? 'shared' : 'direct',
    plan,
  };
}

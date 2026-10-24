/**
 * Sharing defaults.
 *
 * The wizard used to only *warn* when an operator chose a port that was already
 * in use: it told them to pick VLESS + "tls" + "ws" and left every field for
 * them to change by hand. In practice the operator picked the port, read the
 * warning, did not act on it, and ended up with a `tcp` configuration that could
 * never share — which reads as "the panel refuses 443".
 *
 * This module decides, purely, what a configuration's transport settings should
 * become so that it can join an existing port. The wizard applies the result
 * automatically when the operator picks a busy port with a shareable protocol.
 * Keeping it pure means the behaviour is unit-testable and cannot drift from
 * `shareIneligible`, which is the rule the renderer actually enforces.
 */

/**
 * Transports that a fallback parent can actually route on.
 *
 * MEASURED, not assumed. "Exposes a path in the client config" is not the same
 * as "the fallback parent can match on it". Proved with a real client and a real
 * fetch through one fallback parent (`.vpanel/which-transports-can-share.ts`):
 *
 *   ws           -> HTTP 204   WORKS
 *   httpupgrade  -> HTTP 204   WORKS
 *   xhttp        -> HTTP 000   FAILS  (matched no fallback -> dest:1)
 *   grpc         -> HTTP 000   FAILS  (matched no fallback -> dest:1)
 *
 * `xhttp` and `grpc` were previously listed here on the assumption that a path
 * field in the stream settings is enough. It is not: the request never matches a
 * fallback, so the node hands it to the default destination and the port carries
 * no traffic — the operator's "it connects to the port but no data" report.
 * They are valid transports on a DEDICATED port; they simply cannot be shared.
 */
const SHAREABLE_NETWORKS = ['ws', 'httpupgrade'] as const;

/** Protocols that Xray fallbacks support. Only VLESS routes by path. */
const SHAREABLE_PROTOCOLS = ['VLESS', 'TROJAN'] as const;

export interface ShareDefaultsInput {
  protocol: string;
  /** Whether the chosen port is already held by another ACTIVE configuration. */
  portTaken: boolean;
}

export interface ShareDefaults {
  /** Should the operator be told this configuration will share its port? */
  sharing: boolean;
  /** Settings to apply. Empty when nothing needs to change. */
  apply: { network?: string; security?: string };
  /** Human-readable note, shown in the wizard. Null when there is nothing to say. */
  note: string | null;
}

/**
 * Work out the transport settings a configuration needs in order to share the
 * port it was given.
 *
 * Returns `sharing: false` and no changes when the port is free (a dedicated
 * port should stay on the simplest settings — there is nothing to route around).
 */
export function shareDefaults(input: ShareDefaultsInput): ShareDefaults {
  const protocol = input.protocol.toUpperCase();
  const canShare = (SHAREABLE_PROTOCOLS as readonly string[]).includes(protocol);

  if (!input.portTaken) {
    return { sharing: false, apply: {}, note: null };
  }

  if (!canShare) {
    return {
      sharing: false,
      apply: {},
      note:
        `${protocol} cannot share a port, so this configuration needs its own. ` +
        `Pick another port, or switch to VLESS to share.`,
    };
  }

  return {
    sharing: true,
    // Xray requires TLS on a shared listener and a path to route on.
    apply: { network: 'ws', security: 'tls' },
    note:
      'This port is already in use, so it is set up to share: VLESS over WebSocket ' +
      'with TLS. It keeps its own credential, traffic counter and limit. A path was ' +
      'chosen for you — leave it, or set your own (it must start with "/").',
  };
}

/** True when the network is one fallbacks can route on. Mirrors `shareIneligible`. */
export function isShareableNetwork(network: string): boolean {
  return (SHAREABLE_NETWORKS as readonly string[]).includes(network.toLowerCase());
}

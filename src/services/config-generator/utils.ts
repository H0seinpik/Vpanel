import type { Network, Security, StreamSettings } from './types';

/** Standard base64 (padding preserved) — used by vmess:// links. */
export function b64(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64');
}

/** URL-safe base64 without padding — used by ss:// userinfo. */
export function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/**
 * Build a query string, dropping empty/undefined values and encoding safely.
 * Arrays are joined with commas (the convention Xray clients expect for `alpn`).
 */
/**
 * Values that carry no information because they are the protocol's own default.
 *
 * Xray treats an omitted parameter and its default identically, so emitting them
 * only makes the link longer and harder to compare against the server. The
 * operator asked for exactly what xray-core accepts and nothing added on top:
 * a plain `vless` on `tcp` with no security must come out as
 * `?type=tcp&security=none`, not as
 * `?type=tcp&security=none&encryption=none&fp=chrome&headerType=none`.
 */
const REDUNDANT_QUERY_VALUES: Record<string, string> = {
  encryption: 'none', // VLESS encryption default
  headerType: 'none', // tcp/kcp header default
};

export function buildQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (REDUNDANT_QUERY_VALUES[key] !== undefined && String(value) === REDUNDANT_QUERY_VALUES[key]) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
    } else if (typeof value === 'boolean') {
      search.set(key, value ? '1' : '0');
    } else {
      search.set(key, String(value));
    }
  }
  return search.toString();
}

/** Percent-encode a fragment (remark) for a share link. */
export function encodeRemark(remark: string | undefined): string {
  return encodeURIComponent(remark ?? '');
}

/** Compose a share link from parts, appending the fragment only when present. */
export function composeLink(
  scheme: string,
  userInfo: string,
  address: string,
  port: number,
  query: string,
  remark?: string,
): string {
  const base = `${scheme}://${userInfo}@${address}:${port}`;
  const withQuery = query ? `${base}?${query}` : base;
  return remark ? `${withQuery}#${encodeRemark(remark)}` : withQuery;
}

/**
 * Translate flat network/security params into the nested `streamSettings` object
 * Xray expects. This is the single place transport mapping happens, so adding a
 * network only requires editing this function.
 */
export function buildStreamSettings(input: {
  network: Network;
  security: Security;
  sni?: string;
  host?: string;
  path?: string;
  serviceName?: string;
  alpn?: string[];
  fingerprint?: string;
  publicKey?: string;
  shortId?: string;
  spiderX?: string;
    /**
     * XHTTP transport options. Only the client-safe subset is exposed — see the
     * `xhttp` case below and `.vpanel/xhttp-match-test.ts`.
     */
    xhttpMode?: string;
    xhttpXmux?: boolean;
    xhttpXmuxMaxCon?: number;
    xhttpXmuxMaxWorkTimeMs?: number;
    xhttpScMaxEachPostBytes?: number;
    xhttpScMinPostsIntervalMs?: number;
    xhttpScMaxBufferedPosts?: number;
    xhttpPadding?: string;
    headerType?: string;
    /**
     * SHA-256 of the server certificate, hex-encoded.
     *
     * This replaces `allowInsecure`, which **Xray 26 removed**: a config that
     * still carries it fails to load with
     * `The feature "allowInsecure" has been removed and migrated to
     * "pinnedPeerCertSha256"`. Pinning is also strictly better — it trusts that
     * one certificate instead of disabling verification entirely.
     */
    pinnedPeerCertSha256?: string;
  }): StreamSettings {
    const {
      network,
      security,
      sni,
      host,
      path,
      serviceName,
      alpn,
      fingerprint,
      publicKey,
      shortId,
      spiderX,
      headerType,
      pinnedPeerCertSha256,
      xhttpMode,
      xhttpXmux,
      xhttpXmuxMaxCon,
      xhttpXmuxMaxWorkTimeMs,
      xhttpScMaxEachPostBytes,
      xhttpScMinPostsIntervalMs,
      xhttpScMaxBufferedPosts,
      xhttpPadding,
    } = input;

    const stream: StreamSettings = { network, security };

    if (security === 'tls') {
      stream.tlsSettings = {
        serverName: sni || host || undefined,
        ...(pinnedPeerCertSha256 ? { pinnedPeerCertSha256 } : {}),
        ...(alpn && alpn.length ? { alpn } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      };
    }

  if (security === 'reality') {
    stream.realitySettings = {
      serverName: sni || host || undefined,
      fingerprint: fingerprint || 'chrome',
      publicKey: publicKey || undefined,
      shortId: shortId || undefined,
      spiderX: spiderX || undefined,
    };
  }

  switch (network) {
    case 'ws':
      stream.wsSettings = {
        path: path || '/',
        headers: host ? { Host: host } : undefined,
      };
      break;
    case 'grpc':
      stream.grpcSettings = {
        serviceName: serviceName || '',
        multiMode: false,
      };
      break;
    // Xray 26 removed the `http`, `h2`, `quic` and `kcp` transports outright
    // ("has been removed and migrated to XHTTP"), and it refuses to start at all
    // when an inbound uses one — so they are not offered any more and have no
    // renderer here. See NETWORKS in types.ts.
    case 'httpupgrade':
      stream.httpupgradeSettings = {
        path: path || '/',
        host: host || undefined,
      };
      break;
    case 'xhttp': {
      // Only `auto` and `packet-up` are offered. MEASURED
      // (`.vpanel/xhttp-match-test.ts`): with the server on `stream-up` or
      // `stream-one`, a client that did not set the same mode got NO DATA — and a
      // share link cannot carry `mode`, so those two would break every client.
      const xhttp: Record<string, unknown> = {
        path: path || '/',
        host: host || undefined,
        mode: xhttpMode === 'packet-up' ? 'packet-up' : 'auto',
      };

      // `extra` is server-side tuning: measured safe for clients that know nothing
      // about it. xmux lets several requests share one connection, which is the
      // only thing here that actually REDUCES the request count on the node.
      const extra: Record<string, unknown> = {};

      // Download pacing. Xray's own defaults (1 MB per POST, 30 ms between them)
      // are a throughput ceiling on any link with latency, so the panel defaults
      // remove it. They are server-side and never change what a client sends.
      extra.scMaxEachPostBytes = Number(xhttpScMaxEachPostBytes ?? 8_000_000);
      extra.scMinPostsIntervalMs = Number(xhttpScMinPostsIntervalMs ?? 0);
      extra.scMaxBufferedPosts = Number(xhttpScMaxBufferedPosts ?? 256);

      if (xhttpXmux) {
        extra.xmux = {
          maxCon: Number(xhttpXmuxMaxCon ?? 16),
          maxWorkTimeMs: Number(xhttpXmuxMaxWorkTimeMs ?? 30_000),
        };
      }
      if (xhttpPadding) extra.xPaddingBytes = String(xhttpPadding);
      if (Object.keys(extra).length > 0) xhttp.extra = extra;

      stream.xhttpSettings = xhttp;
      break;
    }
    case 'tcp':
    default:
      if (headerType === 'http') {
        stream.tcpSettings = {
          header: { type: 'http', request: { path: [path || '/'], headers: host ? { Host: [host] } : {} } },
        };
      }
      break;
  }

  return stream;
}

/** Assemble a complete client config with local SOCKS + HTTP inbounds. */
export function buildClientConfig(
  outbound: Record<string, unknown>,
  tag: string,
  localPort = 10808,
): Record<string, unknown> {
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'socks-in',
        port: localPort,
        listen: '127.0.0.1',
        protocol: 'socks',
        settings: { udp: true, auth: 'noauth' },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
      },
      {
        tag: 'http-in',
        port: localPort + 1,
        listen: '127.0.0.1',
        protocol: 'http',
        settings: {},
      },
    ],
    outbounds: [
      outbound,
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', outboundTag: tag, network: 'tcp,udp' }],
    },
  };
}

/** Pretty JSON with a trailing newline — the download payload. */
export function toJsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Filesystem-safe slug for download filenames. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'config';
}

/**
 * Shared advisory checks that apply to every transport-aware protocol.
 * Returns warnings (non-fatal) and mutates nothing.
 */
export function streamWarnings(input: {
  network: Network;
  security: Security;
  sni?: string;
  host?: string;
  path?: string;
  publicKey?: string;
  shortId?: string;
}): string[] {
  const warnings: string[] = [];
  const { network, security, sni, host, path, publicKey, shortId } = input;

  if ((security === 'tls' || security === 'reality') && !sni && !host) {
    warnings.push('SNI/Host not set — clients may fail TLS handshake; defaulted to server address.');
  }
  if (security === 'reality' && !publicKey) {
    warnings.push('REALITY requires a public key (pbk) — configuration is incomplete.');
  }
  if (security === 'reality' && !shortId) {
    warnings.push('REALITY shortId is empty; some clients require it.');
  }
  if ((network === 'ws' || network === 'httpupgrade') && !path) {
    warnings.push(`Network "${network}" usually needs an explicit path; defaulted to "/".`);
  }
  if (network === 'grpc' && !path) {
    warnings.push('gRPC transport uses serviceName rather than path — leaving it empty is valid.');
  }
  return warnings;
}

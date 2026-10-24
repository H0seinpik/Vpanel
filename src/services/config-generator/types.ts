import { z } from 'zod';
import { normalizePath } from './path';

// -----------------------------------------------------------------------------
// Shared building blocks
// -----------------------------------------------------------------------------

/**
 * Transport networks this Xray build accepts.
 *
 * MEASURED against the real binary (`.vpanel/xray26-transports.ts`, `xray run
 * -test` per transport). Xray 26 REMOVED four of them:
 *
 *   http  -> "The feature HTTP transport has been removed and migrated to XHTTP"
 *   h2    -> same
 *   quic  -> "The feature QUIC transport has been removed and migrated to XHTTP"
 *   kcp   -> "The feature mkcp header & seed has been removed"
 *
 * They are gone from the list because Xray does not skip an inbound it cannot
 * build — it refuses to start AT ALL, so one configuration on a removed
 * transport takes every other configuration down with it. That happened on
 * 2026-09-28 with an mKCP configuration.
 */
export const NETWORKS = ['tcp', 'ws', 'grpc', 'httpupgrade', 'xhttp'] as const;
export const networkSchema = z.enum(NETWORKS);
export type Network = z.infer<typeof networkSchema>;

/** Transport security layers. */
export const SECURITIES = ['none', 'tls', 'reality'] as const;
export const securitySchema = z.enum(SECURITIES);
export type Security = z.infer<typeof securitySchema>;

/** TLS fingerprint presets accepted by modern clients (uTLS). */
export const FINGERPRINTS = [
  'chrome',
  'firefox',
  'safari',
  'ios',
  'android',
  'edge',
  '360',
  'qq',
  'random',
  'randomized',
] as const;

export const hostPortSchema = {
  address: z.string().min(1, 'Server address is required').max(255),
  port: z.coerce.number().int().min(1).max(65535),
};

/**
 * The XHTTP modes this panel will set.
 *
 * Xray also accepts `stream-up` and `stream-one`, but MEASURED
 * (`.vpanel/xhttp-match-test.ts`): with the server on either of those, a client
 * that did not set the SAME mode got no data at all — and a share link cannot
 * carry a mode. So they are never offered.
 */
export const XHTTP_MODES = ['auto', 'packet-up'] as const;
export const xhttpModeSchema = z.enum(XHTTP_MODES);
export type XhttpMode = z.infer<typeof xhttpModeSchema>;

/** Fields shared by every transport-aware protocol (VLESS/VMess/Trojan). */
export const streamFields = {
  network: networkSchema.default('tcp'),
  /**
   * An empty string is treated as "not chosen" and falls through to the default.
   *
   * A `<Select>` whose value never got seeded submits `""`, and a bare
   * `z.enum().default()` rejects that with
   * "Invalid enum value. Expected 'none' | 'tls' | 'reality', received ''" —
   * a dead end for the operator, who has no way to know which control was empty.
   * `undefined` lets the schema default apply instead.
   */
  security: z.preprocess((value) => (value === '' ? undefined : value), securitySchema.default('none')),
  /**
   * XHTTP transport options, MEASURED against this build
   * (`.vpanel/xhttp-options-probe.ts`, `xray run -test` per option). Xray accepts
   * `path`, `host`, `mode` (auto | packet-up | stream-up | stream-one),
   * `extra.{scMaxBufferedPosts, scMaxEachPostBytes, scMinPostsIntervalMs,
   * noSSEHeader, xPaddingBytes, xmux}` and `noGRPCHeader`; `headers` is rejected
   * when it contains "host".
   *
   * Only `auto` and `packet-up` are offered for `mode`: MEASURED
   * (`.vpanel/xhttp-match-test.ts`) — with the server on `stream-up` or
   * `stream-one` a client that did not set the same mode got NO DATA, and a share
   * link cannot carry `mode`. `extra.xmux` (several requests sharing one
   * connection) and `extra.xPaddingBytes` are server-side and never break a client.
   */
  xhttpMode: xhttpModeSchema.default('auto'),
  xhttpXmux: z.boolean().default(false),
  xhttpXmuxMaxCon: z.coerce.number().int().min(1).max(64).default(16),
  xhttpXmuxMaxWorkTimeMs: z.coerce.number().int().min(0).max(300_000).default(30_000),
  /**
   * Download pacing — the settings that actually cap xhttp speed.
   *
   * Xray's defaults are `scMaxEachPostBytes` 1 MB and `scMinPostsIntervalMs`
   * 30 ms, which means one megabyte per round trip and never more than ~33 POSTs
   * a second. On a link with any real latency that is the ceiling. These defaults
   * remove the cap: 8 MB per POST, no forced interval, 256 buffered.
   *
   * The pre-apply `xray run -test` gate catches it if a build ever rejects one.
   */
  xhttpScMaxEachPostBytes: z.coerce.number().int().min(0).max(64_000_000).default(8_000_000),
  xhttpScMinPostsIntervalMs: z.coerce.number().int().min(0).max(1_000).default(0),
  xhttpScMaxBufferedPosts: z.coerce.number().int().min(0).max(4_096).default(256),
  xhttpPadding: z.string().max(32).optional(),
  sni: z.string().max(255).optional(),
  host: z.string().max(255).optional(),
  /**
   * Request path for a path-based transport.
   *
   * Normalisation happens in `streamFieldsSchema()` below, not here, because it
   * needs to see the sibling `network` field. A bare `z.string().optional()` here
   * is what allowed the empty value that produced a node expecting `/` and a link
   * carrying no path at all.
   */
  path: z.string().max(512).optional(),
  serviceName: z.string().max(128).optional(),
  alpn: z.array(z.string().max(32)).max(8).optional(),
  fingerprint: z.enum(FINGERPRINTS).optional(),
  publicKey: z.string().max(256).optional(),
  shortId: z.string().max(64).optional(),
  spiderX: z.string().max(64).optional(),
  headerType: z.enum(['none', 'http']).optional(),
  /**
   * SHA-256 of the server certificate (hex), for servers using a self-signed
   * certificate. Replaces `allowInsecure`, which Xray 26 removed — a config
   * carrying that field no longer loads at all.
   */
  pinnedPeerCertSha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'Must be a 64-character hex SHA-256 digest')
    .optional(),
  remark: z.string().max(120).optional(),
};

// -----------------------------------------------------------------------------
// Per-protocol parameter schemas
// -----------------------------------------------------------------------------

/**
 * Apply path normalisation to a whole params object.
 *
 * Needs the object (not the field) because the rule depends on the sibling
 * `network`. A path-based transport with no path is SET to `/` so that the node
 * renderer and the share-link generator agree; a value that cannot work (a
 * fingerprint, a missing leading slash) is rejected with an actionable message.
 *
 * Without this, an empty path produced `wsSettings.path = "/"` on the node and
 * **no `path=` at all** in the client link — the "port pings but no data"
 * symptom, seen live on 2026-09-28.
 *
 * The result type is the schema's *input* type; callers read the normalised
 * value from the parsed output, which is what `generateConfig` does.
 */
function withNormalizedPath<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema
    .superRefine((value, ctx) => {
      const params = value as { network?: string; path?: string };
      const result = normalizePath(String(params.network ?? ''), params.path);
      if (!result.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['path'],
          message: `${result.reason} — ${result.fix}`,
        });
      }
    })
    .transform((value) => {
      const params = value as { network?: string; path?: string };
      const result = normalizePath(String(params.network ?? ''), params.path);
      if (result.ok && result.value !== params.path) {
        return { ...value, path: result.value };
      }
      return value;
    });
}

export const vlessParamsSchema = withNormalizedPath(
  z.object({
    uuid: z.string().uuid('A valid UUID is required for VLESS'),
    ...hostPortSchema,
    ...streamFields,
    /**
     * VLESS keeps the schema default of `none`, which is what the operator's
     * clients accept and what their original working configuration used.
     *
     * REALITY is chosen explicitly in the wizard; when it is, the service
     * generates the keypair and the link carries pbk/sid/sni. What must NEVER
     * happen is the middle state this used to produce: `security` absent from the
     * stored params, the link claiming REALITY from the schema default, and no
     * keys anywhere — an unusable link that also made the node skip the config.
     */
    encryption: z.string().default('none'),
    flow: z.enum(['', 'xtls-rprx-vision']).default(''),
  }),
);

export const vmessParamsSchema = withNormalizedPath(
  z.object({
    uuid: z.string().uuid('A valid UUID is required for VMess'),
    ...hostPortSchema,
    ...streamFields,
    alterId: z.coerce.number().int().min(0).max(65535).default(0),
    cipher: z.enum(['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero']).default('auto'),
  }),
);

export const trojanParamsSchema = withNormalizedPath(
  z.object({
    password: z.string().min(8, 'Trojan passwords should be at least 8 characters').max(128),
    ...hostPortSchema,
    ...streamFields,
    flow: z.enum(['', 'xtls-rprx-vision']).default(''),
  }),
);

export const shadowsocksParamsSchema = z.object({
  password: z.string().min(6, 'Shadowsocks passwords should be at least 6 characters').max(128),
  ...hostPortSchema,
  method: z
    .enum([
      'aes-128-gcm',
      'aes-256-gcm',
      'chacha20-ietf-poly1305',
      'xchacha20-ietf-poly1305',
      '2022-blake3-aes-128-gcm',
      '2022-blake3-aes-256-gcm',
      '2022-blake3-chacha20-poly1305',
    ])
    .default('chacha20-ietf-poly1305'),
  plugin: z.string().max(256).optional(),
  pluginOpts: z.string().max(256).optional(),
  remark: z.string().max(120).optional(),
});

export type VlessParams = z.infer<typeof vlessParamsSchema>;
export type VmessParams = z.infer<typeof vmessParamsSchema>;
export type TrojanParams = z.infer<typeof trojanParamsSchema>;
export type ShadowsocksParams = z.infer<typeof shadowsocksParamsSchema>;

export type ProtocolParams =
  | VlessParams
  | VmessParams
  | TrojanParams
  | ShadowsocksParams;

// -----------------------------------------------------------------------------
// Generator contract
// -----------------------------------------------------------------------------

export interface StreamSettings {
  network: Network;
  security: Security;
  tlsSettings?: Record<string, unknown>;
  realitySettings?: Record<string, unknown>;
  tcpSettings?: Record<string, unknown>;
  wsSettings?: Record<string, unknown>;
  grpcSettings?: Record<string, unknown>;
  httpSettings?: Record<string, unknown>;
  kcpSettings?: Record<string, unknown>;
  quicSettings?: Record<string, unknown>;
  httpupgradeSettings?: Record<string, unknown>;
  xhttpSettings?: Record<string, unknown>;
}

export interface GeneratedConfig {
  /** Protocol family this artefact belongs to. */
  protocol: 'VLESS' | 'VMESS' | 'TROJAN' | 'SHADOWSOCKS';
  /** Normalised (validated + defaulted) parameters. */
  params: Record<string, unknown>;
  /** Client outbound object, ready to paste into an Xray `outbounds` array. */
  outbound: Record<string, unknown>;
  /** Full client config (inbounds + outbounds) for download. */
  clientConfig: Record<string, unknown>;
  /** Server-side inbound template for the node operator. */
  serverInbound: Record<string, unknown>;
  /** Import URL consumed by NekoBox / v2rayN / Shadowrocket / sing-box. */
  shareLink: string;
  /** Payload to render as a QR code (identical to the share link for these protocols). */
  qrPayload: string;
  /** Suggested download filename. */
  filename: string;
  /** Download body (pretty-printed client config JSON). */
  fileContent: string;
  /** Non-fatal advisories (e.g. "SNI missing, defaulted to host"). */
  warnings: string[];
}

export interface Generator {
  type: GeneratedConfig['protocol'];
  /** Zod schema used to validate raw input. */
  schema: z.ZodTypeAny;
  generate(rawParams: unknown, ctx?: GenerateContext): GeneratedConfig;
}

export interface GenerateContext {
  /** Human-readable configuration name, used as the remark/tag. */
  name?: string;
  /** Optional per-user credential override (multi-user configs). */
  credential?: Record<string, unknown>;
}

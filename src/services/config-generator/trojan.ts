import {
  type GeneratedConfig,
  type Generator,
  trojanParamsSchema,
} from './types';
import {
  buildClientConfig,
  buildQuery,
  buildStreamSettings,
  composeLink,
  slugify,
  streamWarnings,
  toJsonFile,
} from './utils';

/**
 * Trojan — TLS-mimicking protocol. Always operates over TLS, so the security
 * layer is forced to `tls` when the caller leaves it as `none`.
 */
export const trojanGenerator: Generator = {
  type: 'TROJAN',
  schema: trojanParamsSchema,

  generate(rawParams: unknown, ctx): GeneratedConfig {
    const parsed = trojanParamsSchema.parse(rawParams);
    // Trojan requires TLS by design.
    const params = parsed.security === 'none' ? { ...parsed, security: 'tls' as const } : parsed;

    const remark = ctx?.name?.trim() || params.remark?.trim() || `${params.address}:${params.port}`;

    const warnings = streamWarnings({
      network: params.network,
      security: params.security,
      sni: params.sni,
      host: params.host,
      path: params.path,
    });
    if (parsed.security === 'none') {
      warnings.push('Trojan mandates TLS — security was upgraded from "none" to "tls".');
    }
    if (params.security === 'reality') {
      warnings.push('REALITY with Trojan is non-standard; verify client compatibility.');
    }

    // Share link --------------------------------------------------------------
    const query = buildQuery({
      type: params.network,
      security: params.security,
      sni: params.sni || params.host,
      host: params.host,
      path: params.path,
      serviceName: params.serviceName,
      alpn: params.alpn,
      fp: params.fingerprint,
      pinnedPeerCertSha256: params.pinnedPeerCertSha256,
      headerType: params.headerType,
    });

    const shareLink = composeLink(
      'trojan',
      encodeURIComponent(params.password),
      params.address,
      params.port,
      query,
      remark,
    );

    // Structured Xray objects -------------------------------------------------
    const streamSettings = buildStreamSettings({
      network: params.network,
      security: params.security,
      sni: params.sni || params.host,
      host: params.host,
      path: params.path,
      serviceName: params.serviceName,
      alpn: params.alpn,
      fingerprint: params.fingerprint,
      headerType: params.headerType,
      pinnedPeerCertSha256: params.pinnedPeerCertSha256,
      xhttpMode: params.xhttpMode,
      xhttpXmux: params.xhttpXmux,
      xhttpXmuxMaxCon: params.xhttpXmuxMaxCon,
      xhttpXmuxMaxWorkTimeMs: params.xhttpXmuxMaxWorkTimeMs,
      xhttpPadding: params.xhttpPadding,
      xhttpScMaxEachPostBytes: params.xhttpScMaxEachPostBytes,
      xhttpScMinPostsIntervalMs: params.xhttpScMinPostsIntervalMs,
      xhttpScMaxBufferedPosts: params.xhttpScMaxBufferedPosts,
    });

    const outbound = {
      tag: 'proxy',
      protocol: 'trojan',
      settings: {
        servers: [
          {
            address: params.address,
            port: params.port,
            password: params.password,
            ...(params.flow ? { flow: params.flow } : {}),
          },
        ],
      },
      streamSettings,
    };

    const serverInbound = {
      tag: 'trojan-in',
      listen: '0.0.0.0',
      port: params.port,
      protocol: 'trojan',
      settings: {
        clients: [{ password: params.password, email: remark }],
      },
      streamSettings,
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
    };

    const clientConfig = buildClientConfig(outbound, 'proxy');

    return {
      protocol: 'TROJAN',
      params: params as unknown as Record<string, unknown>,
      outbound,
      clientConfig,
      serverInbound,
      shareLink,
      qrPayload: shareLink,
      filename: `trojan-${slugify(remark)}.json`,
      fileContent: toJsonFile(clientConfig),
      warnings,
    };
  },
};

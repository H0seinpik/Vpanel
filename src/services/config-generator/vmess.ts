import {
  type GeneratedConfig,
  type Generator,
  vmessParamsSchema,
} from './types';
import {
  b64,
  buildClientConfig,
  buildStreamSettings,
  slugify,
  streamWarnings,
  toJsonFile,
} from './utils';

/**
 * VMess — legacy-but-ubiquitous protocol. The import link uses the widely
 * supported base64-encoded JSON payload (v2rayN / NekoBox / Shadowrocket).
 */
export const vmessGenerator: Generator = {
  type: 'VMESS',
  schema: vmessParamsSchema,

  generate(rawParams: unknown, ctx): GeneratedConfig {
    const params = vmessParamsSchema.parse(rawParams);
    const remark = ctx?.name?.trim() || params.remark?.trim() || `${params.address}:${params.port}`;

    const warnings = streamWarnings({
      network: params.network,
      security: params.security,
      sni: params.sni,
      host: params.host,
      path: params.path,
    });

    if (params.security === 'reality') {
      warnings.push('REALITY is not part of the VMess spec — use VLESS for REALITY transport.');
    }
    if (params.alterId !== 0) {
      warnings.push('alterId > 0 is deprecated in modern Xray builds; 0 is recommended.');
    }

    // Share link --------------------------------------------------------------
    const payload = {
      v: '2',
      ps: remark,
      add: params.address,
      port: String(params.port),
      id: params.uuid,
      aid: String(params.alterId),
      scy: params.cipher,
      net: params.network,
      type: params.headerType || 'none',
      host: params.host || '',
      path: params.path || '',
      tls: params.security === 'tls' ? 'tls' : '',
      sni: params.sni || '',
      alpn: params.alpn?.join(',') || '',
      fp: params.fingerprint || '',
    };
    const shareLink = `vmess://${b64(JSON.stringify(payload))}`;

    // Structured Xray objects -------------------------------------------------
    const streamSettings = buildStreamSettings({
      network: params.network,
      security: params.security,
      sni: params.sni,
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
      protocol: 'vmess',
      settings: {
        vnext: [
          {
            address: params.address,
            port: params.port,
            users: [
              {
                id: params.uuid,
                alterId: params.alterId,
                security: params.cipher,
              },
            ],
          },
        ],
      },
      streamSettings,
    };

    const serverInbound = {
      tag: 'vmess-in',
      listen: '0.0.0.0',
      port: params.port,
      protocol: 'vmess',
      settings: {
        clients: [
          { id: params.uuid, alterId: params.alterId, security: params.cipher, email: remark },
        ],
      },
      streamSettings,
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
    };

    const clientConfig = buildClientConfig(outbound, 'proxy');

    return {
      protocol: 'VMESS',
      params: params as unknown as Record<string, unknown>,
      outbound,
      clientConfig,
      serverInbound,
      shareLink,
      qrPayload: shareLink,
      filename: `vmess-${slugify(remark)}.json`,
      fileContent: toJsonFile(clientConfig),
      warnings,
    };
  },
};

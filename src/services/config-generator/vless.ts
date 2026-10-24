import {
  type GeneratedConfig,
  type Generator,
  vlessParamsSchema,
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
 * Is this address a public IPv4 literal? Xray-26 clients refuse VLESS without
 * TLS over one, so the generator warns instead of handing out a link that no
 * recent client will import.
 */
function isBarePublicIp(address: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(address)) return false; // a domain is fine
  const parts = address.split('.').map(Number);
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return false; // private / loopback
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

/**
 * VLESS — modern, stateless protocol. Supports XTLS-Vision flow, REALITY and
 * every transport in the shared stream settings builder.
 */
export const vlessGenerator: Generator = {
  type: 'VLESS',
  schema: vlessParamsSchema,

  generate(rawParams: unknown, ctx): GeneratedConfig {
    const params = vlessParamsSchema.parse(rawParams);
    const remark = ctx?.name?.trim() || params.remark?.trim() || `${params.address}:${params.port}`;

    // Vision flow is a TLS-only codec on TCP: it must be stripped from anything
    // else, because a link carrying a flow its transport cannot honour is
    // rejected or silently dead. REALITY counts as TLS here — Vision over REALITY
    // is the standard pairing.
    const visionCapable =
      params.network === 'tcp' && (params.security === 'tls' || params.security === 'reality');
    const effectiveFlow = visionCapable ? params.flow : '';

    const warnings = streamWarnings({
      network: params.network,
      security: params.security,
      sni: params.sni,
      host: params.host,
      path: params.path,
      publicKey: params.publicKey,
      shortId: params.shortId,
    });

    if (params.security === 'none' && isBarePublicIp(params.address)) {
      warnings.push(
        'Xray-26 clients REFUSE VLESS without TLS when the address is a public IP ' +
          '("vless without TLS or other encryption is prohibited") — use security=reality.',
      );
    }

    if (params.flow === 'xtls-rprx-vision' && !visionCapable) {
      warnings.push(
        'flow=xtls-rprx-vision requires the TCP transport; it was removed from this link.',
      );
    }

    // The uTLS fingerprint only means anything with a TLS-like security layer;
    // carrying `fp=chrome` on a plain `tcp` link is noise the server never sees.
    const usesTlsLike = params.security === 'tls' || params.security === 'reality';

    // Share link (import URL) ------------------------------------------------
    // XHTTP-specific parameters must only appear when the transport is xhttp;
    // including them on tcp/ws/grpc links makes the URL longer and confuses
    // clients that see parameters they do not recognise for the chosen type.
    const isXhttp = params.network === 'xhttp';
    const query = buildQuery({
      type: params.network,
      security: params.security,
      encryption: params.encryption,
      flow: effectiveFlow,
      sni: params.sni,
      host: params.host,
      path: params.path,
      serviceName: params.serviceName,
      alpn: params.alpn,
      fp: usesTlsLike ? params.fingerprint : undefined,
      pbk: params.publicKey,
      sid: params.shortId,
      spx: params.spiderX,
      headerType: params.headerType,
      pinnedPeerCertSha256: params.pinnedPeerCertSha256,
      ...(isXhttp
        ? {
            xhttpMode: params.xhttpMode,
            xhttpXmux: params.xhttpXmux,
            xhttpXmuxMaxCon: params.xhttpXmuxMaxCon,
            xhttpXmuxMaxWorkTimeMs: params.xhttpXmuxMaxWorkTimeMs,
            xhttpPadding: params.xhttpPadding,
            xhttpScMaxEachPostBytes: params.xhttpScMaxEachPostBytes,
            xhttpScMinPostsIntervalMs: params.xhttpScMinPostsIntervalMs,
            xhttpScMaxBufferedPosts: params.xhttpScMaxBufferedPosts,
          }
        : {}),
    });

    const shareLink = composeLink(
      'vless',
      params.uuid,
      params.address,
      params.port,
      query,
      remark,
    );

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
      publicKey: params.publicKey,
      shortId: params.shortId,
      spiderX: params.spiderX,
      headerType: params.headerType,
      pinnedPeerCertSha256: params.pinnedPeerCertSha256,
    });

    const outbound = {
      tag: 'proxy',
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: params.address,
            port: params.port,
            users: [
              {
                id: params.uuid,
                encryption: params.encryption,
                ...(effectiveFlow ? { flow: effectiveFlow } : {}),
              },
            ],
          },
        ],
      },
      streamSettings,
    };

    const serverInbound = {
      tag: 'vless-in',
      listen: '0.0.0.0',
      port: params.port,
      protocol: 'vless',
      settings: {
        clients: [
          {
            id: params.uuid,
            ...(effectiveFlow ? { flow: effectiveFlow } : {}),
            email: remark,
          },
        ],
        decryption: 'none',
      },
      streamSettings,
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
    };

    const clientConfig = buildClientConfig(outbound, 'proxy');

    return {
      protocol: 'VLESS',
      params: params as unknown as Record<string, unknown>,
      outbound,
      clientConfig,
      serverInbound,
      shareLink,
      qrPayload: shareLink,
      filename: `vless-${slugify(remark)}.json`,
      fileContent: toJsonFile(clientConfig),
      warnings,
    };
  },
};

import {
  type GeneratedConfig,
  type Generator,
  shadowsocksParamsSchema,
} from './types';
import {
  b64url,
  buildClientConfig,
  buildQuery,
  composeLink,
  slugify,
  toJsonFile,
} from './utils';

/**
 * Shadowsocks — SIP002 share format:
 *   ss://base64url(method:password)@host:port/?plugin=...#remark
 */
export const shadowsocksGenerator: Generator = {
  type: 'SHADOWSOCKS',
  schema: shadowsocksParamsSchema,

  generate(rawParams: unknown, ctx): GeneratedConfig {
    const params = shadowsocksParamsSchema.parse(rawParams);
    const remark = ctx?.name?.trim() || params.remark?.trim() || `${params.address}:${params.port}`;
    const warnings: string[] = [];

    if (params.method.startsWith('2022-')) {
      warnings.push(
        'Shadowsocks 2022 ciphers require a base64-encoded key rather than a passphrase — verify the client.',
      );
    }

    // Share link --------------------------------------------------------------
    const userInfo = b64url(`${params.method}:${params.password}`);
    const query = buildQuery({
      plugin: params.plugin
        ? params.pluginOpts
          ? `${params.plugin};${params.pluginOpts}`
          : params.plugin
        : undefined,
    });

    const shareLink = composeLink('ss', userInfo, params.address, params.port, query, remark);

    // Structured Xray objects -------------------------------------------------
    const outbound = {
      tag: 'proxy',
      protocol: 'shadowsocks',
      settings: {
        servers: [
          {
            address: params.address,
            port: params.port,
            method: params.method,
            password: params.password,
            ...(params.plugin ? { plugin: params.plugin, pluginOpts: params.pluginOpts } : {}),
          },
        ],
      },
      streamSettings: { network: 'tcp', security: 'none' },
    };

    const serverInbound = {
      tag: 'ss-in',
      listen: '0.0.0.0',
      port: params.port,
      protocol: 'shadowsocks',
      settings: { method: params.method, password: params.password, network: 'tcp,udp' },
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
    };

    const clientConfig = buildClientConfig(outbound, 'proxy');

    return {
      protocol: 'SHADOWSOCKS',
      params: params as unknown as Record<string, unknown>,
      outbound,
      clientConfig,
      serverInbound,
      shareLink,
      qrPayload: shareLink,
      filename: `shadowsocks-${slugify(remark)}.json`,
      fileContent: toJsonFile(clientConfig),
      warnings,
    };
  },
};

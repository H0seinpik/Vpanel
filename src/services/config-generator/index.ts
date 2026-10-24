import { randomUuid } from '@/lib/crypto';
import { randomToken } from '@/lib/crypto';
import { vlessGenerator } from './vless';
import { vmessGenerator } from './vmess';
import { trojanGenerator } from './trojan';
import { shadowsocksGenerator } from './shadowsocks';
import {
  FINGERPRINTS,
  NETWORKS,
  SECURITIES,
  type GeneratedConfig,
  type GenerateContext,
  type Generator,
} from './types';

export * from './types';
export * from './utils';

// -----------------------------------------------------------------------------
// Registry — adding a protocol means adding one entry here plus a generator file.
// -----------------------------------------------------------------------------

export const GENERATORS: Record<GeneratedConfig['protocol'], Generator> = {
  VLESS: vlessGenerator,
  VMESS: vmessGenerator,
  TROJAN: trojanGenerator,
  SHADOWSOCKS: shadowsocksGenerator,
};

export const SUPPORTED_PROTOCOLS = Object.keys(GENERATORS) as GeneratedConfig['protocol'][];

export function getGenerator(type: string): Generator {
  const generator = GENERATORS[type.toUpperCase() as GeneratedConfig['protocol']];
  if (!generator) {
    throw new Error(
      `Unsupported protocol "${type}". Supported: ${SUPPORTED_PROTOCOLS.join(', ')}`,
    );
  }
  return generator;
}

/** Validate raw params for a protocol. Throws a ZodError on failure. */
export function validateParams(type: string, params: unknown) {
  return getGenerator(type).schema.parse(params);
}

/** Safe validation returning a discriminated result instead of throwing. */
export function safeValidateParams(
  type: string,
  params: unknown,
): { ok: true; data: unknown } | { ok: false; errors: string[] } {
  const result = getGenerator(type).schema.safeParse(params);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`),
  };
}

/**
 * Generate a configuration artefact. The caller supplies validated-or-raw
 * parameters; validation happens inside the generator so every code path is
 * guarded (the API and the wizard both funnel through here).
 */
export function generateConfig(
  type: string,
  params: unknown,
  ctx?: GenerateContext,
): GeneratedConfig {
  return getGenerator(type).generate(params, ctx);
}

// -----------------------------------------------------------------------------
// Credential generation for the multi-user model
// -----------------------------------------------------------------------------

/**
 * Produce an independent credential for a user on a given protocol. Protocols
 * that support per-user identities get a fresh UUID; passphrase-based protocols
 * get a strong random passphrase. This guarantees one user's credential is never
 * shared with — or derivable from — another user's.
 */
export function generateCredential(type: string, existing?: Record<string, unknown>) {
  const upper = type.toUpperCase();
  switch (upper) {
    case 'VLESS':
    case 'VMESS':
      return { uuid: randomUuid() };
    case 'TROJAN':
    case 'SHADOWSOCKS':
      return { password: randomToken(18) };
    default:
      return existing?.uuid ? { uuid: existing.uuid } : { uuid: randomUuid() };
  }
}

/** Merge a per-user credential into a configuration's base params. */
export function applyCredential(
  type: string,
  baseParams: Record<string, unknown>,
  credential: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...baseParams, ...credential };
  // Strip credentials that do not apply to this protocol.
  const upper = type.toUpperCase();
  if (upper === 'VLESS' || upper === 'VMESS') delete merged.password;
  if (upper === 'TROJAN' || upper === 'SHADOWSOCKS') delete merged.uuid;
  return merged;
}

// -----------------------------------------------------------------------------
// UI field descriptors — the wizard renders itself from this data, so the
// frontend never hard-codes the configuration format.
// -----------------------------------------------------------------------------

export interface FieldDescriptor {
  name: string;
  label: string;
  type: 'text' | 'number' | 'password' | 'select' | 'switch' | 'textarea' | 'tags';
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { label: string; value: string }[];
  group: 'endpoint' | 'transport' | 'security' | 'advanced';
  /** Only render when the sibling field equals one of these values. */
  visibleWhen?: { field: string; equals: string[] };
  advanced?: boolean;
}

const asOptions = (values: readonly string[]) =>
  values.map((v) => ({ label: v, value: v }));

const transportFields = (withFlow: boolean): FieldDescriptor[] => [
  {
    name: 'network',
    label: 'Network / Transport',
    type: 'select',
    required: true,
    group: 'transport',
    options: asOptions(NETWORKS),
    help: 'Transport used between client and server.',
  },
  {
    name: 'path',
    label: 'Path',
    type: 'text',
    group: 'transport',
    placeholder: '/ray',
    visibleWhen: { field: 'network', equals: ['ws', 'http', 'h2', 'httpupgrade', 'xhttp', 'tcp'] },
  },
  {
    name: 'serviceName',
    label: 'gRPC service name',
    type: 'text',
    group: 'transport',
    visibleWhen: { field: 'network', equals: ['grpc'] },
  },
  {
    name: 'xhttpMode',
    label: 'XHTTP mode',
    type: 'select',
    group: 'transport',
    options: [
      { value: 'auto', label: 'auto — کار میکند با همهٔ کلاینتها' },
      { value: 'packet-up', label: 'packet-up — آپلود سریعتر' },
    ],
    help:
      'فقط این دو حالت ارائه میشوند: حالتهای stream-up و stream-one کلاینتی را که ' +
      'همان را در لینک نداشته باشد قطع میکنند (اندازهگیری شده).',
    visibleWhen: { field: 'network', equals: ['xhttp'] },
  },
  {
    name: 'xhttpXmux',
    label: 'XHTTP multiplexing (xmux)',
    type: 'switch',
    group: 'transport',
    help:
      'چند درخواست را روی یک اتصال میفرستد — تعداد اتصالها و فشار روی سرور کمتر ' +
      'میشود. فقط سمت سرور است و برای کلاینت نیازی به تنظیم ندارد.',
    visibleWhen: { field: 'network', equals: ['xhttp'] },
  },
  {
    name: 'xhttpXmuxMaxCon',
    label: 'xmux — بیشینهٔ اتصال همزمان',
    type: 'number',
    group: 'transport',
    placeholder: '8',
    visibleWhen: { field: 'network', equals: ['xhttp'] },
  },
  {
    name: 'xhttpXmuxMaxWorkTimeMs',
    label: 'xmux — بیشینهٔ عمر هر اتصال (میلیثانیه)',
    type: 'number',
    group: 'transport',
    placeholder: '15000',
    visibleWhen: { field: 'network', equals: ['xhttp'] },
  },
  {
    name: 'xhttpPadding',
    label: 'XHTTP padding (پوشاندن اندازهٔ بسته‌ها)',
    type: 'text',
    group: 'transport',
    placeholder: '100-1000',
    help: 'اختیاری. حجم بستهها را پوشش میدهد ولی ترافیک را کمی بیشتر میکند. خالی بگذار.',
    visibleWhen: { field: 'network', equals: ['xhttp'] },
  },
  {
    name: 'headerType',
    label: 'Header type',
    type: 'select',
    group: 'advanced',
    advanced: true,
    options: asOptions(['none', 'http']),
    visibleWhen: { field: 'network', equals: ['tcp', 'quic', 'kcp'] },
  },
  {
    name: 'security',
    label: 'Security',
    type: 'select',
    required: true,
    group: 'security',
    options: asOptions(SECURITIES),
  },
  {
    name: 'sni',
    label: 'SNI',
    type: 'text',
    group: 'security',
    placeholder: 'example.com',
    visibleWhen: { field: 'security', equals: ['tls', 'reality'] },
  },
  {
    name: 'host',
    label: 'Host header',
    type: 'text',
    group: 'security',
    placeholder: 'example.com',
    visibleWhen: { field: 'security', equals: ['tls', 'reality'] },
  },
  {
    name: 'fingerprint',
    label: 'uTLS fingerprint',
    type: 'select',
    group: 'advanced',
    advanced: true,
    options: asOptions(FINGERPRINTS),
    visibleWhen: { field: 'security', equals: ['tls', 'reality'] },
  },
  {
    name: 'publicKey',
    label: 'REALITY public key (pbk)',
    type: 'text',
    group: 'advanced',
    advanced: true,
    help: 'Generated automatically — leave blank.',
    visibleWhen: { field: 'security', equals: ['reality'] },
  },
  {
    name: 'shortId',
    label: 'REALITY short ID (sid)',
    type: 'text',
    group: 'advanced',
    advanced: true,
    help: 'Generated automatically — leave blank.',
    visibleWhen: { field: 'security', equals: ['reality'] },
  },
  {
    name: 'spiderX',
    label: 'REALITY spiderX',
    type: 'text',
    group: 'advanced',
    advanced: true,
    visibleWhen: { field: 'security', equals: ['reality'] },
  },
  {
    name: 'alpn',
    label: 'ALPN',
    type: 'tags',
    group: 'advanced',
    advanced: true,
    placeholder: 'h2, http/1.1',
    visibleWhen: { field: 'security', equals: ['tls', 'reality'] },
  },
  // NOTE: there is deliberately no "allow insecure TLS" switch.
  //
  // Xray 26 removed `allowInsecure` — a config carrying it fails to load — and
  // replaced it with `pinnedPeerCertSha256`. The panel derives that pin from
  // the node's own certificate automatically (see `withTlsPin` in
  // xray-service), so there is nothing for an operator to type here.
  ...(withFlow
    ? ([
        {
          name: 'flow',
          label: 'Flow',
          type: 'select',
          group: 'advanced',
          advanced: true,
          options: [
            { label: 'none', value: '' },
            { label: 'xtls-rprx-vision', value: 'xtls-rprx-vision' },
          ],
          visibleWhen: { field: 'network', equals: ['tcp'] },
        },
      ] as FieldDescriptor[])
    : []),
];

const PROTOCOL_FIELDS: Record<string, FieldDescriptor[]> = {
  VLESS: [
    { name: 'uuid', label: 'UUID', type: 'text', required: true, group: 'endpoint', help: 'Auto-generated if left blank.' },
    { name: 'address', label: 'Server address', type: 'text', required: true, group: 'endpoint' },
    { name: 'port', label: 'Port', type: 'number', required: true, group: 'endpoint', placeholder: '443' },
    { name: 'encryption', label: 'Encryption', type: 'select', group: 'advanced', advanced: true, options: [{ label: 'none', value: 'none' }] },
    ...transportFields(true),
  ],
  VMESS: [
    { name: 'uuid', label: 'UUID', type: 'text', required: true, group: 'endpoint', help: 'Auto-generated if left blank.' },
    { name: 'address', label: 'Server address', type: 'text', required: true, group: 'endpoint' },
    { name: 'port', label: 'Port', type: 'number', required: true, group: 'endpoint', placeholder: '443' },
    { name: 'alterId', label: 'alterId', type: 'number', group: 'advanced', advanced: true, placeholder: '0' },
    {
      name: 'cipher',
      label: 'Cipher',
      type: 'select',
      group: 'advanced',
      advanced: true,
      options: asOptions(['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero']),
    },
    ...transportFields(false),
  ],
  TROJAN: [
    { name: 'password', label: 'Password', type: 'password', required: true, group: 'endpoint', help: 'Auto-generated if left blank.' },
    { name: 'address', label: 'Server address', type: 'text', required: true, group: 'endpoint' },
    { name: 'port', label: 'Port', type: 'number', required: true, group: 'endpoint', placeholder: '443' },
    ...transportFields(true),
  ],
  SHADOWSOCKS: [
    { name: 'password', label: 'Password', type: 'password', required: true, group: 'endpoint' },
    { name: 'address', label: 'Server address', type: 'text', required: true, group: 'endpoint' },
    { name: 'port', label: 'Port', type: 'number', required: true, group: 'endpoint' },
    {
      name: 'method',
      label: 'Method',
      type: 'select',
      required: true,
      group: 'endpoint',
      options: asOptions([
        'aes-128-gcm',
        'aes-256-gcm',
        'chacha20-ietf-poly1305',
        'xchacha20-ietf-poly1305',
        '2022-blake3-aes-128-gcm',
        '2022-blake3-aes-256-gcm',
        '2022-blake3-chacha20-poly1305',
      ]),
    },
    { name: 'plugin', label: 'Plugin', type: 'text', group: 'advanced', advanced: true, placeholder: 'v2ray-plugin' },
    { name: 'pluginOpts', label: 'Plugin options', type: 'text', group: 'advanced', advanced: true },
  ],
};

/** Field descriptors driving the wizard UI for a protocol. */
export function getProtocolFields(type: string): FieldDescriptor[] {
  return PROTOCOL_FIELDS[type.toUpperCase()] ?? PROTOCOL_FIELDS.VLESS;
}

/** Metadata for the protocol picker. */
export function listProtocols() {
  return SUPPORTED_PROTOCOLS.map((type) => ({
    type,
    label: type,
    description: {
      VLESS: 'Lightweight, stateless. Supports XTLS-Vision and REALITY.',
      VMESS: 'Widely compatible legacy protocol with UUID auth.',
      TROJAN: 'TLS-mimicking protocol, indistinguishable from HTTPS traffic.',
      SHADOWSOCKS: 'Simple, fast encrypted proxy with multiple ciphers.',
    }[type],
    supportsMultiUser: type === 'VLESS' || type === 'VMESS' || type === 'TROJAN',
  }));
}

import { describe, expect, it } from 'vitest';
import {
  applyCredential,
  generateConfig,
  generateCredential,
  getProtocolFields,
  listProtocols,
  safeValidateParams,
  SUPPORTED_PROTOCOLS,
  validateParams,
} from '@/services/config-generator';

/**
 * Configuration generator tests.
 *
 * These cover the contract every generator must satisfy: a structured outbound,
 * a share link, a QR payload and a downloadable file — plus input validation and
 * the guarantee that per-user credentials are independent.
 */

const BASE = { address: 'node01.example.com', port: 443 };

describe('protocol registry', () => {
  it('exposes the four supported protocols', () => {
    expect(SUPPORTED_PROTOCOLS).toEqual(['VLESS', 'VMESS', 'TROJAN', 'SHADOWSOCKS']);
  });

  it('lists protocol metadata including multi-user support', () => {
    const protocols = listProtocols();
    expect(protocols).toHaveLength(4);
    const vless = protocols.find((p) => p.type === 'VLESS');
    expect(vless?.supportsMultiUser).toBe(true);
    expect(protocols.find((p) => p.type === 'SHADOWSOCKS')?.supportsMultiUser).toBe(false);
  });

  it('returns field descriptors that drive the wizard UI', () => {
    const fields = getProtocolFields('VLESS');
    const names = fields.map((field) => field.name);
    expect(names).toContain('uuid');
    expect(names).toContain('network');
    expect(names).toContain('security');
    // REALITY-only fields are present but gated by a visibility rule.
    const publicKey = fields.find((field) => field.name === 'publicKey');
    expect(publicKey?.visibleWhen).toEqual({ field: 'security', equals: ['reality'] });
  });
});

describe('VLESS generator', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('generates a valid share link with transport parameters', () => {
    const result = generateConfig('VLESS', {
      ...BASE,
      uuid,
      network: 'ws',
      security: 'tls',
      sni: 'node01.example.com',
      host: 'node01.example.com',
      path: '/ray',
      flow: 'xtls-rprx-vision',
    });

    expect(result.protocol).toBe('VLESS');
    expect(result.shareLink.startsWith('vless://')).toBe(true);
    expect(result.shareLink).toContain(uuid);
    expect(result.shareLink).toContain('type=ws');
    expect(result.shareLink).toContain('security=tls');
    expect(result.shareLink).toContain('path=%2Fray');
    expect(result.qrPayload).toBe(result.shareLink);
  });

  it('produces a structured Xray outbound and inbound', () => {
    const result = generateConfig('VLESS', { ...BASE, uuid, network: 'tcp', security: 'none' });
    const outbound = result.outbound as Record<string, any>;
    const inbound = result.serverInbound as Record<string, any>;

    expect(outbound.protocol).toBe('vless');
    expect(outbound.settings.vnext[0].users[0].id).toBe(uuid);
    expect(outbound.streamSettings.network).toBe('tcp');
    expect(inbound.protocol).toBe('vless');
    expect(inbound.settings.decryption).toBe('none');
  });

  it('returns a downloadable client config containing SOCKS and HTTP inbounds', () => {
    const result = generateConfig('VLESS', { ...BASE, uuid });
    expect(result.filename).toMatch(/^vless-.*\.json$/);
    const parsed = JSON.parse(result.fileContent);
    expect(parsed.inbounds).toHaveLength(2);
    expect(parsed.outbounds[0].protocol).toBe('vless');
  });

  it('rejects a missing UUID', () => {
    expect(() => generateConfig('VLESS', BASE)).toThrow();
  });

  it('rejects an invalid UUID', () => {
    expect(() => generateConfig('VLESS', { ...BASE, uuid: 'not-a-uuid' })).toThrow();
  });

  it('warns when REALITY is selected without a public key', () => {
    const result = generateConfig('VLESS', {
      ...BASE,
      uuid,
      security: 'reality',
      sni: 'example.com',
    });
    expect(result.warnings.some((warning) => warning.includes('public key'))).toBe(true);
  });

  it('warns when the Vision flow is combined with a non-TCP transport', () => {
    const result = generateConfig('VLESS', {
      ...BASE,
      uuid,
      network: 'ws',
      path: '/x',
      flow: 'xtls-rprx-vision',
    });
    expect(result.warnings.some((warning) => warning.includes('xtls-rprx-vision'))).toBe(true);
  });
});

describe('VMess generator', () => {
  const uuid = '22222222-2222-4222-8222-222222222222';

  it('encodes the v2rayN-compatible base64 JSON payload', () => {
    const result = generateConfig('VMESS', { ...BASE, uuid, network: 'ws', path: '/ws' });
    expect(result.shareLink.startsWith('vmess://')).toBe(true);

    const encoded = result.shareLink.replace('vmess://', '');
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(decoded.id).toBe(uuid);
    expect(decoded.add).toBe(BASE.address);
    expect(decoded.port).toBe(String(BASE.port));
    expect(decoded.net).toBe('ws');
  });

  it('warns about a non-zero alterId', () => {
    const result = generateConfig('VMESS', { ...BASE, uuid, alterId: 64 });
    expect(result.warnings.some((warning) => warning.includes('alterId'))).toBe(true);
  });
});

describe('Trojan generator', () => {
  it('forces TLS even when security is none', () => {
    const result = generateConfig('TROJAN', {
      ...BASE,
      password: 'super-secret-password',
      security: 'none',
    });
    expect(result.shareLink.startsWith('trojan://')).toBe(true);
    expect(result.shareLink).toContain('security=tls');
    expect(result.warnings.some((warning) => warning.includes('TLS'))).toBe(true);
  });

  it('percent-encodes the password in the link', () => {
    const result = generateConfig('TROJAN', { ...BASE, password: 'p@ss word#1' });
    expect(result.shareLink).toContain(encodeURIComponent('p@ss word#1'));
  });

  it('rejects a short password', () => {
    expect(() => generateConfig('TROJAN', { ...BASE, password: 'short' })).toThrow();
  });
});

describe('Shadowsocks generator', () => {
  it('emits a SIP002 link with base64url userinfo', () => {
    const result = generateConfig('SHADOWSOCKS', {
      ...BASE,
      password: 'correct-horse-battery',
      method: 'chacha20-ietf-poly1305',
    });

    expect(result.shareLink.startsWith('ss://')).toBe(true);
    const userInfo = result.shareLink.replace('ss://', '').split('@')[0]!;
    const decoded = Buffer.from(userInfo, 'base64url').toString('utf8');
    expect(decoded).toBe('chacha20-ietf-poly1305:correct-horse-battery');
  });

  it('warns for 2022 ciphers', () => {
    const result = generateConfig('SHADOWSOCKS', {
      ...BASE,
      password: 'a-very-long-passphrase',
      method: '2022-blake3-aes-256-gcm',
    });
    expect(result.warnings.some((warning) => warning.includes('2022'))).toBe(true);
  });
});

describe('validation helpers', () => {
  it('returns structured errors instead of throwing', () => {
    const result = safeValidateParams('VLESS', { address: '', port: 99999 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('normalises defaults through the schema', () => {
    const params = validateParams('VLESS', {
      address: 'a.example.com',
      port: '443',
      uuid: '33333333-3333-4333-8333-333333333333',
    }) as Record<string, unknown>;
    expect(params.port).toBe(443);
    expect(params.network).toBe('tcp');
    // VLESS keeps `none` as its default — that is the form the operator's
    // clients accept. REALITY is chosen explicitly, and when it is, the service
    // generates the keypair so the link carries pbk/sid/sni.
    expect(params.security).toBe('none');
  });

  it('treats an empty security value as "not chosen" instead of failing', () => {
    // A <Select> that never got seeded submits "", which used to abort the whole
    // creation with "Invalid enum value … received ''".
    const vless = validateParams('VLESS', {
      address: 'a.example.com',
      port: '443',
      uuid: '33333333-3333-4333-8333-333333333333',
      security: '',
    }) as Record<string, unknown>;
    expect(vless.security).toBe('none');

    const vmess = validateParams('VMESS', {
      address: 'a.example.com',
      port: '443',
      uuid: '33333333-3333-4333-8333-333333333333',
      security: '',
    }) as Record<string, unknown>;
    expect(vmess.security).toBe('none');
  });

  it('rejects an unsupported protocol', () => {
    expect(() => generateConfig('WIREGUARD', BASE)).toThrow(/Unsupported protocol/);
  });
});

describe('multi-user credential isolation', () => {
  it('issues a distinct credential per user', () => {
    const first = generateCredential('VLESS');
    const second = generateCredential('VLESS');
    expect(first.uuid).toBeTruthy();
    expect(second.uuid).toBeTruthy();
    expect(first.uuid).not.toBe(second.uuid);
  });

  it('produces different share links for two users on the same configuration', () => {
    const publicParams = { ...BASE, network: 'ws', security: 'tls', path: '/ray', sni: BASE.address };

    const userA = generateCredential('VLESS');
    const userB = generateCredential('VLESS');

    const configA = generateConfig('VLESS', applyCredential('VLESS', publicParams, userA), {
      name: 'Shared node',
    });
    const configB = generateConfig('VLESS', applyCredential('VLESS', publicParams, userB), {
      name: 'Shared node',
    });

    expect(configA.shareLink).not.toBe(configB.shareLink);
    expect(configA.shareLink).toContain(String(userA.uuid));
    expect(configA.shareLink).not.toContain(String(userB.uuid));
  });

  it('strips credentials that do not belong to the protocol', () => {
    const merged = applyCredential('VLESS', { address: 'a', port: 443, password: 'leaked' }, {
      uuid: '44444444-4444-4444-8444-444444444444',
    });
    expect(merged.password).toBeUndefined();
    expect(merged.uuid).toBe('44444444-4444-4444-8444-444444444444');

    const trojanMerged = applyCredential('TROJAN', { address: 'a', port: 443, uuid: 'leaked' }, {
      password: 'secret-password',
    });
    expect(trojanMerged.uuid).toBeUndefined();
    expect(trojanMerged.password).toBe('secret-password');
  });

  it('generates passphrases for passphrase-based protocols', () => {
    const credential = generateCredential('TROJAN');
    expect(typeof credential.password).toBe('string');
    expect((credential.password as string).length).toBeGreaterThanOrEqual(16);
  });
});

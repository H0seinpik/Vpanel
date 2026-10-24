import { describe, expect, it } from 'vitest';
import {
  parseX25519Output,
  randomShortId,
  serverRealitySettings,
  REALITY_DEFAULTS,
} from '../src/services/reality';
import { shareIneligible } from '../src/services/port-sharing';

/**
 * REALITY is the answer to "works on v2rayNG, fails on NekoBox": the node's
 * certificate is self-signed and the sing-box family rejects it, while REALITY
 * needs no certificate at all. These tests pin the pieces that make that true.
 */
describe('parseX25519Output', () => {
  it('parses the real output of `xray x25519`', () => {
    const stdout = [
      'PrivateKey: GJ72qeRe5P5VfatmnM6gcZPmUF8Cb59UJCV9Fr-pG04',
      'Password (PublicKey): wsvAk8IhkWdJ1KjukhPhctavmeR9nJDUggwl3MJaT3s',
      'Hash32: 45YCCqZl5VcWKR0kqH-IPBZyKjEPTpetNvjVRL-NV7Q',
      '',
    ].join('\n');

    expect(parseX25519Output(stdout)).toEqual({
      privateKey: 'GJ72qeRe5P5VfatmnM6gcZPmUF8Cb59UJCV9Fr-pG04',
      publicKey: 'wsvAk8IhkWdJ1KjukhPhctavmeR9nJDUggwl3MJaT3s',
    });
  });

  it('also accepts the bare "PublicKey:" wording of older builds', () => {
    const stdout = 'PrivateKey: abc\nPublicKey: def\n';
    expect(parseX25519Output(stdout)).toEqual({ privateKey: 'abc', publicKey: 'def' });
  });

  it('returns null rather than a half-key when a line is missing', () => {
    expect(parseX25519Output('PrivateKey: abc\n')).toBeNull();
    expect(parseX25519Output('garbage')).toBeNull();
    expect(parseX25519Output('')).toBeNull();
  });
});

describe('randomShortId', () => {
  it('is 8 hex characters, as Xray requires', () => {
    const id = randomShortId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces a fresh value each call', () => {
    const seen = new Set(Array.from({ length: 20 }, () => randomShortId()));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('serverRealitySettings', () => {
  it('builds the server-side object from the params', () => {
    const settings = serverRealitySettings({
      privateKey: 'priv',
      publicKey: 'pub',
      shortId: 'a1b2c3d4',
      sni: 'www.example.com',
      realityDest: 'www.example.com:443',
    });

    expect(settings).toEqual({
      show: false,
      dest: 'www.example.com:443',
      xver: 0,
      serverNames: ['www.example.com'],
      privateKey: 'priv',
      shortIds: ['a1b2c3d4'],
    });
  });

  it('falls back to the default decoy destination and SNI', () => {
    const settings = serverRealitySettings({ privateKey: 'priv' });
    expect(settings?.dest).toBe(REALITY_DEFAULTS.dest);
    expect(settings?.serverNames).toEqual([REALITY_DEFAULTS.serverName]);
    expect(settings?.shortIds).toEqual(['']);
  });

  it('returns null when there is no private key — the inbound cannot start', () => {
    expect(serverRealitySettings({ publicKey: 'pub' })).toBeNull();
    expect(serverRealitySettings({})).toBeNull();
    expect(serverRealitySettings({ privateKey: '   ' })).toBeNull();
  });

  it('never leaks the client-side fields into the node config', () => {
    const settings = serverRealitySettings({
      privateKey: 'priv',
      publicKey: 'pub',
      shortId: 'a1b2c3d4',
      spiderX: '/',
    }) as Record<string, unknown>;

    expect(settings).not.toHaveProperty('publicKey');
    expect(settings).not.toHaveProperty('spiderX');
    expect(settings).not.toHaveProperty('fingerprint');
  });
});

describe('port sharing — REALITY is ineligible', () => {
  it('refuses a REALITY configuration with a reason that names the fix', () => {
    const rejection = shareIneligible({
      id: 'c1',
      name: 'Reality Node',
      protocol: 'VLESS',
      security: 'reality',
      network: 'tcp',
      path: null,
    });

    expect(rejection).not.toBeNull();
    expect(rejection?.reason).toBe('REALITY cannot share a port');
    expect(rejection?.fix).toMatch(/own port/i);
  });
});

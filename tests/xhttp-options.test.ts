import { describe, it, expect } from 'vitest';
import { validateParams } from '../src/services/config-generator';
import { buildStreamSettings } from '../src/services/config-generator/utils';
import { NETWORKS, XHTTP_MODES } from '../src/services/config-generator/types';

const UUID = '33333333-3333-4333-8333-333333333333';

describe('XHTTP transport options', () => {
  it('offers only the client-safe networks and modes', () => {
    // Xray 26 refuses http/h2/quic/kcp outright, and stream-up/stream-one break a
    // client that did not set the same mode (measured in .vpanel/).
    expect(NETWORKS).toEqual(['tcp', 'ws', 'grpc', 'httpupgrade', 'xhttp']);
    expect(XHTTP_MODES).toEqual(['auto', 'packet-up']);
  });

  it('renders xhttpSettings with mode and xmux only when asked', () => {
    // The panel ships the download pacing UN-CAPPED: Xray's own defaults (1 MB
    // per POST, 30 ms between them) are a throughput ceiling on a latent link.
    const plain = buildStreamSettings({ network: 'xhttp', security: 'none' }) as Record<string, any>;
    expect(plain.xhttpSettings.mode).toBe('auto');
    expect(plain.xhttpSettings.path).toBe('/');
    expect(plain.xhttpSettings.extra.scMaxEachPostBytes).toBe(8_000_000);
    expect(plain.xhttpSettings.extra.scMinPostsIntervalMs).toBe(0);
    expect(plain.xhttpSettings.extra.xmux).toBeUndefined();

    const tuned = buildStreamSettings({
      network: 'xhttp',
      security: 'none',
      path: '/vp',
      xhttpMode: 'packet-up',
      xhttpXmux: true,
      xhttpXmuxMaxCon: 16,
      xhttpXmuxMaxWorkTimeMs: 9000,
      xhttpPadding: '100-1000',
    }) as Record<string, any>;

    expect(tuned.xhttpSettings.mode).toBe('packet-up');
    expect(tuned.xhttpSettings.path).toBe('/vp');
    expect(tuned.xhttpSettings.extra.xmux).toEqual({ maxCon: 16, maxWorkTimeMs: 9000 });
    expect(tuned.xhttpSettings.extra.xPaddingBytes).toBe('100-1000');
  });

  it('cannot be set to a mode that would break clients', () => {
    expect(() =>
      validateParams('VLESS', {
        address: 'a.example.com',
        port: '443',
        uuid: UUID,
        network: 'xhttp',
        xhttpMode: 'stream-up',
      }),
    ).toThrow();

    const ok = validateParams('VLESS', {
      address: 'a.example.com',
      port: '443',
      uuid: UUID,
      network: 'xhttp',
      xhttpMode: 'packet-up',
    }) as Record<string, unknown>;
    expect(ok.xhttpMode).toBe('packet-up');
  });

  it('defaults xhttp options to the safe end', () => {
    const params = validateParams('VMESS', {
      address: 'a.example.com',
      port: '443',
      uuid: UUID,
      network: 'xhttp',
    }) as Record<string, unknown>;
    expect(params.xhttpMode).toBe('auto');
    expect(params.xhttpXmux).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { buildTunnelInbound, tunnelAllowedNetwork } from '../src/server/services/xray-service';

/**
 * Xray's tunnel inbound is easy to get subtly wrong: `dokodemo-door` uses
 * `address`/`port`, while the modern `tunnel` protocol uses
 * `rewriteAddress`/`rewritePort`, and UDP support is a comma-separated
 * `allowedNetwork`. These tests pin the exact shape that `xray run -test`
 * accepted on 26.9.8.
 */
describe('tunnel inbound rendering', () => {
  it('maps each stored transport to the Xray spelling', () => {
    expect(tunnelAllowedNetwork('TCP')).toBe('tcp');
    expect(tunnelAllowedNetwork('UDP')).toBe('udp');
    expect(tunnelAllowedNetwork('TCP_UDP')).toBe('tcp,udp');
    expect(tunnelAllowedNetwork('something-else')).toBe('tcp');
  });

  it('renders a modern tunnel inbound with the destination and tag', () => {
    const inbound = buildTunnelInbound({
      id: 'abc123',
      name: 'Germany relay',
      listenAddress: '0.0.0.0',
      listenPort: 8443,
      targetHost: '203.0.113.10',
      targetPort: 443,
      network: 'TCP_UDP',
    });

    expect(inbound).toMatchObject({
      listen: '0.0.0.0',
      port: 8443,
      protocol: 'tunnel',
      tag: 'tunnel-abc123',
      settings: {
        allowedNetwork: 'tcp,udp',
        rewriteAddress: '203.0.113.10',
        rewritePort: 443,
      },
      sniffing: { enabled: false },
    });
  });

  it('falls back to a wildcard listener when no address is stored', () => {
    const inbound = buildTunnelInbound({
      id: 'x',
      name: 'x',
      listenAddress: '',
      listenPort: 2087,
      targetHost: 'example.com',
      targetPort: 80,
      network: 'TCP',
    });

    expect(inbound.listen).toBe('0.0.0.0');
    expect(inbound.settings).toMatchObject({ rewriteAddress: 'example.com', rewritePort: 80 });
  });
});

import { describe, expect, it } from 'vitest';
import { isShareableNetwork, shareDefaults } from '../src/services/sharing-defaults';
import { shareIneligible } from '../src/services/port-sharing';

describe('shareDefaults', () => {
  it('makes no changes when the port is free', () => {
    const result = shareDefaults({ protocol: 'VLESS', portTaken: false });
    expect(result.sharing).toBe(false);
    expect(result.apply).toEqual({});
    expect(result.note).toBeNull();
  });

  it('switches VLESS to ws + tls when the port is taken', () => {
    const result = shareDefaults({ protocol: 'VLESS', portTaken: true });
    expect(result.sharing).toBe(true);
    expect(result.apply).toEqual({ network: 'ws', security: 'tls' });
    expect(result.note).toContain('share');
  });

  it('accepts Trojan as shareable, and lower-case input', () => {
    expect(shareDefaults({ protocol: 'trojan', portTaken: true }).sharing).toBe(true);
  });

  it('refuses to claim a VMess configuration can share', () => {
    const result = shareDefaults({ protocol: 'VMESS', portTaken: true });
    expect(result.sharing).toBe(false);
    expect(result.apply).toEqual({});
    expect(result.note).toContain('cannot share');
  });

  it('produces settings that actually pass shareIneligible', () => {
    // The whole point: the defaults must satisfy the same rule the renderer
    // enforces, or the wizard would promise something the server refuses.
    const { apply } = shareDefaults({ protocol: 'VLESS', portTaken: true });
    const verdict = shareIneligible({
      id: 'x',
      name: 'this configuration',
      protocol: 'VLESS',
      security: apply.security!,
      network: apply.network!,
      path: '/vp-abc12345',
    });
    expect(verdict).toBeNull();
  });

  it('does not set a path itself — the wizard owns path uniqueness', () => {
    const { apply } = shareDefaults({ protocol: 'VLESS', portTaken: true });
    expect(apply).not.toHaveProperty('path');
  });
});

/**
 * The "tcp pings but never connects" report.
 *
 * A `tcp` client against a shared port reaches the port and completes the TLS
 * handshake — so the phone shows a successful ping — then matches no fallback,
 * because routing is by request path and `tcp` has none. The node drops it into
 * the default destination and no data ever flows. The operator sees an open port
 * and no connection, which reads as a server fault when it is purely a transport
 * choice.
 *
 * These tests pin the two things that make that impossible to hit by accident:
 * the renderer refuses the combination, and the refusal says *why*.
 */
describe('tcp against a shared port (the "pings but no data" trap)', () => {
  it('is refused by shareIneligible', () => {
    const verdict = shareIneligible({
      id: 'x',
      name: 'this configuration',
      protocol: 'VLESS',
      security: 'tls',
      network: 'tcp',
      path: null,
    });
    expect(verdict).not.toBeNull();
  });

  it('explains that tcp has no path to route on, and names ws as the fix', () => {
    const verdict = shareIneligible({
      id: 'x',
      name: 'this configuration',
      protocol: 'VLESS',
      security: 'tls',
      network: 'tcp',
      path: null,
    });
    expect(verdict!.reason).toContain('tcp');
    expect(verdict!.reason).toContain('path');
    expect(verdict!.fix).toContain('ws');
  });

  it('is still refused when a path is supplied — tcp cannot use one', () => {
    const verdict = shareIneligible({
      id: 'x',
      name: 'this configuration',
      protocol: 'VLESS',
      security: 'tls',
      network: 'tcp',
      path: '/vp-abc12345',
    });
    expect(verdict).not.toBeNull();
  });

  it('the same configuration on a free port is untouched by the rule', () => {
    // tcp is perfectly valid on its own port — the rule only bites when sharing.
    const { sharing, apply } = shareDefaults({ protocol: 'VLESS', portTaken: false });
    expect(sharing).toBe(false);
    expect(apply).toEqual({});
  });
});

/**
 * xhttp and grpc cannot be shared — measured, not assumed.
 *
 * Both accept a `path` in their stream settings, which is why they were once
 * listed as shareable. A real client through a real fallback proves otherwise:
 * the request matches no fallback, falls through to the default destination, and
 * no data flows. Because the resulting configuration *looks* healthy, it must be
 * refused with an explanation rather than created.
 */
describe('xhttp and grpc on a shared port', () => {
  it.each(['xhttp', 'grpc'])('is refused for %s', (network) => {
    const verdict = shareIneligible({
      id: 'x',
      name: 'this configuration',
      protocol: 'VLESS',
      security: 'tls',
      network,
      path: '/vp-abc12345',
    });
    expect(verdict).not.toBeNull();
    expect(verdict!.reason).toContain(network);
    expect(verdict!.reason).toContain('shared');
  });

  it.each(['xhttp', 'grpc'])('offers both an own-port option and ws for %s', (network) => {
    const verdict = shareIneligible({
      id: 'x',
      name: 'this configuration',
      protocol: 'VLESS',
      security: 'tls',
      network,
      path: '/vp-abc12345',
    });
    expect(verdict!.fix).toContain('ws');
    expect(verdict!.fix).toContain('own port');
  });

  it('does not claim xhttp has "no path" — it has one, it just does not route', () => {
    // The reason must be accurate: xhttp DOES expose a path. Saying otherwise
    // would send the operator hunting for a setting that is already correct.
    const verdict = shareIneligible({
      id: 'x',
      name: 'this configuration',
      protocol: 'VLESS',
      security: 'tls',
      network: 'xhttp',
      path: '/vp-x',
    });
    expect(verdict!.reason).not.toContain('no path');
  });
});

describe('isShareableNetwork', () => {
  // MEASURED against a real Xray node: only ws and httpupgrade actually route
  // through a fallback. xhttp and grpc accept a path in their stream settings but
  // never match a fallback — the request falls through to dest:1 and carries no
  // data. See `.vpanel/which-transports-can-share.ts`.
  it.each(['ws', 'httpupgrade', 'WS', 'HttpUpgrade'])('accepts %s', (network) => {
    expect(isShareableNetwork(network)).toBe(true);
  });

  it.each(['tcp', 'kcp', 'quic', 'http', 'h2', 'xhttp', 'grpc'])(
    'rejects %s',
    (network) => {
      expect(isShareableNetwork(network)).toBe(false);
    },
  );

  it('agrees with shareIneligible for every network it accepts', () => {
    for (const network of ['ws', 'httpupgrade', 'xhttp', 'grpc']) {
      if (!isShareableNetwork(network)) continue;
      const verdict = shareIneligible({
        id: 'x',
        name: 'c',
        protocol: 'VLESS',
        security: 'tls',
        network,
        path: '/vp-x',
      });
      expect(verdict, `${network} should be shareable`).toBeNull();
    }
  });
});

/**
 * The port rules that keep one bad configuration from taking down the node.
 *
 * Background — the report that produced these tests:
 *
 *   "when I open another config on port 443 and after another ports I created
 *    it getting closed ... the other ports get closed and 445 is now open but
 *    there is no connection"
 *
 * Three independent failures hid behind that one sentence:
 *
 *   1. Port 445 belongs to Windows SMB, always. It is *listening*, so it looks
 *      like a working port — but it is not a proxy, so the client sees "open
 *      but no connection".
 *   2. Xray refuses to start AT ALL when one inbound cannot bind. So a single
 *      bad port closes every other port on the machine.
 *   3. Two configurations both claimed 443, and one silently vanished.
 */
import { describe, expect, it } from 'vitest';
import {
  claimedPorts,
  describePortConflict,
  discouragedPortReason,
  portFromBindError,
  staticPortConflict,
  startupFailureLine,
  suggestPort,
  tagFromXrayError,
} from '@/services/port-conflicts';

describe('staticPortConflict', () => {
  it('rejects port 445, which Windows SMB holds permanently', () => {
    const conflict = staticPortConflict(445);

    expect(conflict).not.toBeNull();
    expect(conflict?.permanent).toBe(true);
    expect(conflict?.reason).toContain('SMB');
    // The operator needs to be told what to do, not just that it failed.
    expect(conflict?.fix).toMatch(/high port|8443/);
  });

  it('rejects the other Windows-owned ports an operator might pick by accident', () => {
    for (const port of [135, 139, 1900, 5357, 5985, 5986, 47001]) {
      expect(staticPortConflict(port), `port ${port} should be rejected`).not.toBeNull();
    }
  });

  it('flags the port the panel itself uses for its stats API, without calling it impossible', () => {
    // The panel binds 10085 for the stats API, so a configuration there would
    // collide — but that is our own choice, not an OS constraint. The live bind
    // probe rejects it; the static table only warns.
    expect(discouragedPortReason(10085)).toContain('stats API');
    expect(staticPortConflict(10085)).toBeNull();
  });

  it('accepts the high ports a proxy is normally served on', () => {
    for (const port of [8443, 2053, 2087, 2083, 444, 8080]) {
      expect(staticPortConflict(port), `port ${port} should be accepted`).toBeNull();
    }
  });

  it('rejects out-of-range and non-integer ports', () => {
    expect(staticPortConflict(0)?.permanent).toBe(true);
    expect(staticPortConflict(70000)?.permanent).toBe(true);
    expect(staticPortConflict(Number.NaN)?.permanent).toBe(true);
  });
});

describe('discouragedPortReason', () => {
  it('flags 443 without blocking it', () => {
    // 443 is legal — someone may genuinely terminate TLS there — but it is the
    // most likely port to be intercepted upstream, so it is worth a warning.
    expect(staticPortConflict(443)).toBeNull();
    expect(discouragedPortReason(443)).toContain('intercept');
  });

  it('says nothing about an ordinary high port', () => {
    expect(discouragedPortReason(8443)).toBeNull();
  });
});

describe('describePortConflict', () => {
  it('names the configuration, the port, the reason and the fix', () => {
    const message = describePortConflict('Server 01 · VMESS', staticPortConflict(445)!);

    expect(message).toContain('Server 01 · VMESS');
    expect(message).toContain('445');
    expect(message).toContain('SMB');
    expect(message).toMatch(/8443/);
  });
});

describe('portFromBindError', () => {
  // The exact string Xray 26.9.8 produced on the live node.
  const live =
    'Failed to start: app/proxyman/inbound: failed to listen TCP on 445 > transport/internet: ' +
    'failed to listen on address: 0.0.0.0:445 > transport/internet/tcp: failed to listen TCP on ' +
    '0.0.0.0:445 > listen tcp 0.0.0.0:445: bind: Only one usage of each socket address ' +
    '(protocol/network address/port) is normally permitted.';

  it('recovers the port from Xray’s real bind error', () => {
    expect(portFromBindError(live)).toBe(445);
  });

  it('handles the short forms too', () => {
    expect(portFromBindError('failed to listen TCP on 8443')).toBe(8443);
    expect(portFromBindError('failed to listen on address: 0.0.0.0:2053')).toBe(2053);
  });

  it('returns null when no port is named', () => {
    expect(portFromBindError('Failed to start: something else entirely')).toBeNull();
  });
});

describe('tagFromXrayError', () => {
  it('recovers the inbound tag from a config-build failure', () => {
    expect(
      tagFromXrayError('failed to build inbound config with tag trojan-in > infra/conf: Failed to build TLS config.'),
    ).toBe('trojan-in');
  });

  it('returns null when no tag is named', () => {
    expect(tagFromXrayError('failed to listen TCP on 445')).toBeNull();
  });
});

describe('startupFailureLine', () => {
  it('extracts the failure, not the banner or the deprecation warnings', () => {
    const output = [
      'Xray 26.9.8 (Xray, Penetrates Everything.) 37ceb8b (go1.27.1 windows/amd64)',
      'A unified platform for anti-censorship.',
      '[Info] infra/conf/serial: Reading config: &{Name:C:\\xray\\config.json Format:json}',
      '[Warning] common/errors: The feature VMess (with no Forward Secrecy, etc.) is deprecated',
      'Failed to start: app/proxyman/inbound: failed to listen TCP on 445',
    ].join('\n');

    const line = startupFailureLine(output);

    expect(line).toBe('app/proxyman/inbound: failed to listen TCP on 445');
    // The banner must not be mistaken for the reason.
    expect(line).not.toContain('Penetrates');
    expect(line).not.toContain('[Warning]');
  });

  it('uses the LAST failure line, so a retry’s error wins', () => {
    const output = ['Failed to start: first problem', 'Failed to start: second problem'].join('\n');
    expect(startupFailureLine(output)).toBe('second problem');
  });

  it('returns null when the process produced no failure line', () => {
    expect(startupFailureLine('Xray 26.9.8 started\n')).toBeNull();
  });
});

describe('suggestPort', () => {
  it('offers 443 when nothing is using it', () => {
    expect(suggestPort([])).toBe(443);
  });

  it('never offers a port the wizard would reject anyway', () => {
    // Every preferred port is taken, including 443 — the next suggestion must
    // still be somewhere a proxy can actually be served.
    const taken = [443, 8443, 2053, 2083, 2087, 2096, 444, 8080];
    const next = suggestPort(taken);

    expect(staticPortConflict(next)).toBeNull();
    expect(taken).not.toContain(next);
    expect(next).toBeGreaterThan(9_999);
  });

  it('skips Windows-owned ports while scanning upward', () => {
    // Occupy the whole preferred list and the range up to the first reserved
    // port, so the scan has to step over nothing it should not pick.
    const taken: number[] = [];
    for (let port = 443; port <= 10_085; port += 1) taken.push(port);

    const next = suggestPort(taken);

    expect(staticPortConflict(next)).toBeNull();
    expect(taken).not.toContain(next);
  });

  it('is what stops the second configuration from colliding with the first', () => {
    // The exact production case: the server default port 443 is already held,
    // so the wizard must offer something else rather than pre-filling 443.
    expect(suggestPort([443])).toBe(8443);
  });
});

describe('claimedPorts', () => {
  it('reads the port from the configuration’s own parameters', () => {
    expect(claimedPorts([{ params: { port: 2087 }, server: { port: 443 } }])).toEqual([2087]);
  });

  it('falls back to the server port when the configuration has none', () => {
    // A configuration that inherits its port must still count as claiming it,
    // otherwise the duplicate check misses it.
    expect(claimedPorts([{ params: {}, server: { port: 443 } }])).toEqual([443]);
    expect(claimedPorts([{ params: null, server: { port: 444 } }])).toEqual([444]);
  });

  it('deduplicates and sorts', () => {
    const ports = claimedPorts([
      { params: { port: 2087 } },
      { params: { port: 443 } },
      { params: { port: 2087 } },
      { params: {}, server: { port: 443 } },
    ]);

    expect(ports).toEqual([443, 2087]);
  });

  it('ignores junk values', () => {
    expect(claimedPorts([{ params: { port: 0 } }, { params: { port: 'abc' } }, { params: {} }])).toEqual(
      [],
    );
  });
});

/**
 * Port sharing — many configurations behind one public port.
 *
 * The operator's requirement: "how can i make unlimited config on port 443".
 * A TCP port belongs to one process at a time, so the only honest answer is
 * fallbacks: one listener on 443 routing by path to per-configuration loopback
 * inbounds. These tests pin the rules that make that safe.
 */
import { describe, expect, it } from 'vitest';
import {
  SHARE_INTERNAL_PORT_BASE,
  internalPortFor,
  planPortSharing,
  resolvePortLayout,
  shareIneligible,
  sharePathFor,
  type ShareCandidate,
} from '@/services/port-sharing';

/** A configuration that is allowed to share a port. */
function shareable(overrides: Partial<ShareCandidate> = {}): ShareCandidate {
  return {
    id: 'cmuk9qj4r0013bom0me16s3oq',
    name: 'Customer A',
    protocol: 'VLESS',
    security: 'tls',
    network: 'ws',
    path: null,
    ...overrides,
  };
}

describe('shareIneligible', () => {
  it('accepts VLESS with TLS on a path-capable transport', () => {
    expect(shareIneligible(shareable())).toBeNull();
    expect(shareIneligible(shareable({ protocol: 'TROJAN' }))).toBeNull();
  });

  it('rejects VMess, which cannot participate in fallbacks at all', () => {
    const rejection = shareIneligible(shareable({ protocol: 'VMESS' }));

    expect(rejection).not.toBeNull();
    expect(rejection?.reason).toContain('VMESS cannot share');
    // The operator must be told the way out, not just that it failed.
    expect(rejection?.fix).toMatch(/Recreate|own port/);
  });

  it('rejects Shadowsocks, which has no fallback support either', () => {
    expect(shareIneligible(shareable({ protocol: 'SHADOWSOCKS' }))?.reason).toContain(
      'cannot share',
    );
  });

  it('rejects a configuration without TLS, because the port cannot route it', () => {
    const rejection = shareIneligible(shareable({ security: 'none' }));

    expect(rejection).not.toBeNull();
    expect(rejection?.reason).toContain('TLS');
  });

  it('rejects a transport that has no path to route on', () => {
    const rejection = shareIneligible(shareable({ network: 'tcp' }));

    expect(rejection).not.toBeNull();
    expect(rejection?.reason).toContain('tcp');
    expect(rejection?.fix).toContain('ws');
  });
});

describe('sharePathFor', () => {
  it('produces a path starting with a slash', () => {
    expect(sharePathFor('cmuk9qj4r0013bom0me16s3oq')).toMatch(/^\/vp-/);
  });

  it('is stable for the same id, so client links do not change on reconcile', () => {
    const id = 'cmuk9qj4r0013bom0me16s3oq';
    expect(sharePathFor(id)).toBe(sharePathFor(id));
  });

  it('differs between configurations', () => {
    expect(sharePathFor('cmuk9qj4r0013bom0me16s3oq')).not.toBe(
      sharePathFor('cmuka1z9p001jbom0qkfsu3yt'),
    );
  });
});

describe('internalPortFor', () => {
  it('stays in the loopback-only range', () => {
    const port = internalPortFor('cmuk9qj4r0013bom0me16s3oq', 0);
    expect(port).toBeGreaterThanOrEqual(SHARE_INTERNAL_PORT_BASE);
    expect(port).toBeLessThanOrEqual(65_535);
  });

  it('is deterministic, so a no-op reconcile does not reshuffle ports', () => {
    const id = 'cmuk9qj4r0013bom0me16s3oq';
    expect(internalPortFor(id, 3)).toBe(internalPortFor(id, 3));
  });

  it('gives different configurations different ports', () => {
    const a = internalPortFor('cmuk9qj4r0013bom0me16s3oq', 0);
    const b = internalPortFor('cmuka1z9p001jbom0qkfsu3yt', 0);
    expect(a).not.toBe(b);
  });
});

describe('planPortSharing', () => {
  it('never assigns the same path to two configurations', () => {
    // Two configurations with no path chosen must still end up distinct — the
    // same path on two inbounds makes one of them permanently unreachable with
    // no error anywhere.
    const plan = planPortSharing([
      shareable({ id: 'aaaaaaaaaa01', name: 'A' }),
      shareable({ id: 'bbbbbbbbbb02', name: 'B' }),
      shareable({ id: 'cccccccccc03', name: 'C' }),
    ]);

    const paths = plan.members.map((member) => member.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('disambiguates when two configurations were given the same path', () => {
    const plan = planPortSharing([
      shareable({ id: 'aaaaaaaaaa01', name: 'A', path: '/same' }),
      shareable({ id: 'bbbbbbbbbb02', name: 'B', path: '/same' }),
    ]);

    const paths = plan.members.map((member) => member.path);
    expect(paths).toContain('/same');
    expect(paths).toContain('/same-2');
    expect(new Set(paths).size).toBe(2);
  });

  it('normalises paths so "/x" and "x" cannot both be claimed', () => {
    const plan = planPortSharing([
      shareable({ id: 'aaaaaaaaaa01', name: 'A', path: 'x' }),
      shareable({ id: 'bbbbbbbbbb02', name: 'B', path: '/x' }),
    ]);

    const paths = plan.members.map((member) => member.path);
    expect(new Set(paths).size).toBe(2);
    expect(paths).toContain('/x');
  });

  it('keeps the operator’s own path so existing client links keep working', () => {
    const plan = planPortSharing([shareable({ path: '/my-customer' })]);
    expect(plan.members[0]?.path).toBe('/my-customer');
  });

  it('reports ineligible configurations instead of silently dropping them', () => {
    const plan = planPortSharing([
      shareable({ id: 'aaaaaaaaaa01', name: 'Good' }),
      shareable({ id: 'bbbbbbbbbb02', name: 'Bad', protocol: 'VMESS' }),
    ]);

    expect(plan.members).toHaveLength(1);
    expect(plan.members[0]?.name).toBe('Good');
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.name).toBe('Bad');
    expect(plan.rejected[0]?.fix).toBeTruthy();
  });

  it('gives every member a unique loopback port', () => {
    const plan = planPortSharing([
      shareable({ id: 'aaaaaaaaaa01' }),
      shareable({ id: 'bbbbbbbbbb02' }),
      shareable({ id: 'cccccccccc03' }),
    ]);

    const ports = plan.members.map((member) => member.internalPort);
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe('resolvePortLayout', () => {
  it('keeps a single configuration on a direct inbound, with no fallback hop', () => {
    const { mode } = resolvePortLayout([shareable()]);
    expect(mode).toBe('direct');
  });

  it('switches to fallbacks as soon as two configurations want the port', () => {
    const { mode, plan } = resolvePortLayout([
      shareable({ id: 'aaaaaaaaaa01', name: 'A' }),
      shareable({ id: 'bbbbbbbbbb02', name: 'B' }),
    ]);

    expect(mode).toBe('shared');
    expect(plan.members).toHaveLength(2);
  });

  it('stays direct when only one of two is eligible', () => {
    // One usable configuration does not need a fallback listener, so it keeps
    // the simpler layout rather than gaining a pointless indirection.
    const { mode, plan } = resolvePortLayout([
      shareable({ id: 'aaaaaaaaaa01', name: 'A' }),
      shareable({ id: 'bbbbbbbbbb02', name: 'B', protocol: 'VMESS' }),
    ]);

    expect(mode).toBe('direct');
    expect(plan.rejected).toHaveLength(1);
  });

  it('supports many configurations on one port — the actual requirement', () => {
    const many = Array.from({ length: 25 }, (_unused, index) =>
      shareable({ id: `config-${String(index).padStart(4, '0')}`, name: `Customer ${index}` }),
    );

    const { mode, plan } = resolvePortLayout(many);

    expect(mode).toBe('shared');
    expect(plan.members).toHaveLength(25);
    expect(plan.rejected).toHaveLength(0);
    expect(new Set(plan.members.map((m) => m.path)).size).toBe(25);
    expect(new Set(plan.members.map((m) => m.internalPort)).size).toBe(25);
  });
});

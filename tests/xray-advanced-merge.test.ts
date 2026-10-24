import { describe, expect, it } from 'vitest';
import { mergeAdvancedObjects, type AdvancedObjects } from '@/server/services/xray-advanced';

/**
 * Phase 2 contract: the generated base config must survive the merge untouched.
 * These tests pin the properties that make the integration safe — if one of them
 * fails, an operator's existing configurations could stop working.
 */

const empty: AdvancedObjects = { inbounds: [], outbounds: [], routing: [], reverse: [] };

function base() {
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'api', listen: '127.0.0.1', port: 10085, protocol: 'dokodemo-door' },
      { tag: 'vpanel-abc', listen: '0.0.0.0', port: 443, protocol: 'vless' },
    ],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'blocked' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', inboundTag: ['api'], outboundTag: 'api' }],
    },
  };
}

describe('mergeAdvancedObjects', () => {
  it('returns the base untouched when there is nothing to merge', () => {
    const source = base();
    const out = mergeAdvancedObjects(source, empty);
    expect(out.config).toEqual(source);
    expect(out.config).not.toHaveProperty('reverse');
    expect(out.warnings).toEqual([]);
    expect(out.counts).toEqual({ inbounds: 0, outbounds: 0, rules: 0, reverse: 0 });
  });

  it('keeps "direct" as the FIRST outbound (Xray uses it as the default route)', () => {
    const out = mergeAdvancedObjects(base(), {
      ...empty,
      outbounds: [
        {
          id: 'o1',
          name: 'foreign',
          tag: 'foreign',
          protocol: 'vless',
          settings: {},
          streamSettings: {},
          sendThrough: null,
          sortOrder: 0,
        },
      ],
    });
    const outbounds = out.config.outbounds as Array<{ tag: string }>;
    expect(outbounds[0]?.tag).toBe('direct');
    expect(outbounds.at(-1)?.tag).toBe('foreign');
  });

  it('skips an inbound whose tag already exists (Xray would refuse to start)', () => {
    const out = mergeAdvancedObjects(base(), {
      ...empty,
      inbounds: [
        {
          id: 'i1',
          name: 'clash',
          tag: 'vpanel-abc',
          protocol: 'vless',
          listen: '0.0.0.0',
          port: 8443,
          settings: {},
          streamSettings: {},
          sniffing: {},
          sortOrder: 0,
        },
      ],
    });
    expect(out.counts.inbounds).toBe(0);
    expect(out.warnings.join(' ')).toContain('already used');
    expect((out.config.inbounds as unknown[]).length).toBe(2);
  });

  it('skips an inbound on a port the base already serves', () => {
    const out = mergeAdvancedObjects(base(), {
      ...empty,
      inbounds: [
        {
          id: 'i1',
          name: 'duplicate',
          tag: 'fresh-tag',
          protocol: 'vless',
          listen: '0.0.0.0',
          port: 443,
          settings: {},
          streamSettings: {},
          sniffing: {},
          sortOrder: 0,
        },
      ],
    });
    expect(out.counts.inbounds).toBe(0);
    expect(out.warnings.join(' ')).toContain('already used');
  });

  it('appends a valid inbound, reports its port, and omits empty sections', () => {
    const out = mergeAdvancedObjects(base(), {
      ...empty,
      inbounds: [
        {
          id: 'i1',
          name: 'portal',
          tag: 'portal-in',
          protocol: 'vless',
          listen: '0.0.0.0',
          port: 9000,
          settings: { clients: [] },
          streamSettings: {},
          sniffing: {},
          sortOrder: 0,
        },
      ],
    });
    expect(out.counts.inbounds).toBe(1);
    expect(out.ports).toEqual([9000]);

    const inbounds = out.config.inbounds as Array<Record<string, unknown>>;
    expect(inbounds.at(-1)).toMatchObject({ tag: 'portal-in', port: 9000, protocol: 'vless' });
    expect(inbounds.at(-1)).not.toHaveProperty('streamSettings');
    expect(inbounds.at(-1)).not.toHaveProperty('sniffing');
  });

  it('puts operator routing rules AFTER the infrastructure rules', () => {
    const out = mergeAdvancedObjects(base(), {
      ...empty,
      routing: [
        {
          id: 'r1',
          name: 'iran-domains',
          sortOrder: 0,
          outboundTag: 'direct',
          balancerTag: null,
          inboundTags: [],
          domain: ['geosite:ir'],
          ip: [],
          port: null,
          sourceIp: [],
          sourcePort: null,
          protocol: [],
          network: null,
        },
      ],
    });
    const rules = (out.config.routing as { rules: Array<Record<string, unknown>> }).rules;
    expect(rules[0]).toMatchObject({ inboundTag: ['api'], outboundTag: 'api' });
    expect(rules.at(-1)).toMatchObject({ domain: ['geosite:ir'], outboundTag: 'direct', type: 'field' });
    expect(rules.at(-1)).not.toHaveProperty('inboundTag');
  });

  it('skips a routing rule with no outbound or balancer tag', () => {
    const out = mergeAdvancedObjects(base(), {
      ...empty,
      routing: [
        {
          id: 'r1',
          name: 'empty-rule',
          sortOrder: 0,
          outboundTag: null,
          balancerTag: null,
          inboundTags: [],
          domain: [],
          ip: [],
          port: null,
          sourceIp: [],
          sourcePort: null,
          protocol: [],
          network: null,
        },
      ],
    });
    expect(out.counts.rules).toBe(0);
    expect(out.warnings.join(' ')).toContain('no outboundTag');
  });

  it('builds the reverse block only when there are rows', () => {
    const out = mergeAdvancedObjects(base(), {
      ...empty,
      reverse: [
        { id: 'p1', name: 'portal', role: 'PORTAL', tag: 'portal', domain: 'foreign.example' },
        { id: 'b1', name: 'bridge', role: 'BRIDGE', tag: 'bridge', domain: 'iran.example' },
      ],
    });
    expect(out.config.reverse).toEqual({
      bridges: [{ tag: 'bridge', domain: 'iran.example' }],
      portals: [{ tag: 'portal', domain: 'foreign.example' }],
    });
    expect(out.counts.reverse).toBe(2);
  });
});

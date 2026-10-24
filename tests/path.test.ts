import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  pathSurvivesLink,
  DEFAULT_PATH,
  PATH_BASED_NETWORKS,
} from '../src/services/config-generator/path';
import {
  vlessParamsSchema,
  vmessParamsSchema,
  trojanParamsSchema,
} from '../src/services/config-generator/types';
import { generateConfig } from '../src/services/config-generator';

/**
 * The bug these tests pin down (observed live 2026-09-28):
 *
 *   DB:   params.path = ""
 *   Node: wsSettings.path = "/"          (utils.ts: `path || '/'`)
 *   Link: no `path=` parameter at all    (utils.ts buildQuery skips '')
 *
 * The port opened and pinged, but the request matched no route — "connects but
 * no data". Normalisation at the schema is what makes all three agree.
 */

const base = {
  uuid: 'b53cfcd5-e2c2-49ba-989c-db79d42afdae',
  address: '195.248.241.251',
  port: 443,
  network: 'ws',
  security: 'tls',
  fingerprint: 'chrome',
} as const;

const FINGERPRINT = '24098dd21a1a8f23f9d8ed96fb5f943479f718c8fd18ce418e1bad5b7502fd72';

function linkPathFor(link: string): string | null {
  return new URL(link.replace(/^[a-z]+:/, 'https:')).searchParams.get('path');
}

describe('normalizePath', () => {
  it('turns an empty path on a path-based transport into the default', () => {
    expect(normalizePath('ws', '')).toEqual({ ok: true, value: DEFAULT_PATH });
    expect(normalizePath('ws', '   ')).toEqual({ ok: true, value: DEFAULT_PATH });
  });

  it('turns a missing path on a path-based transport into the default', () => {
    expect(normalizePath('ws', undefined)).toEqual({ ok: true, value: DEFAULT_PATH });
    expect(normalizePath('ws', null)).toEqual({ ok: true, value: DEFAULT_PATH });
  });

  it('treats a bare slash as the default', () => {
    expect(normalizePath('ws', '/')).toEqual({ ok: true, value: DEFAULT_PATH });
  });

  it('keeps a well-formed path unchanged', () => {
    expect(normalizePath('ws', '/vp-main')).toEqual({ ok: true, value: '/vp-main' });
  });

  it('trims surrounding whitespace', () => {
    expect(normalizePath('ws', '  /vp-main  ')).toEqual({ ok: true, value: '/vp-main' });
  });

  it('defaults for every path-based transport', () => {
    for (const network of PATH_BASED_NETWORKS) {
      expect(normalizePath(network, '')).toEqual({ ok: true, value: DEFAULT_PATH });
    }
  });

  it('drops a leftover path on a transport with no path concept', () => {
    expect(normalizePath('tcp', '/leftover')).toEqual({ ok: true, value: '' });
    expect(normalizePath('grpc', '/leftover')).toEqual({ ok: true, value: '' });
    expect(normalizePath('kcp', '/leftover')).toEqual({ ok: true, value: '' });
  });

  it('refuses a path with no leading slash, and names the fix', () => {
    const result = normalizePath('ws', 'vp-main');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/start with/);
      expect(result.fix).toContain('/vp-main');
    }
  });

  it('refuses the certificate-fingerprint trap', () => {
    const result = normalizePath('ws', FINGERPRINT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/fingerprint/i);
    }
  });

  it('refuses a fingerprint written with a leading slash', () => {
    expect(normalizePath('ws', `/${FINGERPRINT}`).ok).toBe(false);
  });

  it('does not mistake a normal word for a fingerprint', () => {
    expect(normalizePath('ws', '/vp-main').ok).toBe(true);
    expect(normalizePath('ws', '/abcdef').ok).toBe(true);
  });

  it('refuses spaces and "#"', () => {
    expect(normalizePath('ws', '/a b').ok).toBe(false);
    expect(normalizePath('ws', '/a#b').ok).toBe(false);
  });
});

describe('pathSurvivesLink', () => {
  it('is satisfied when a path-based transport carries a path', () => {
    expect(pathSurvivesLink('ws', '/')).toBe(true);
    expect(pathSurvivesLink('ws', '/vp-main')).toBe(true);
  });

  it('fails when a path-based transport carries none', () => {
    expect(pathSurvivesLink('ws', '')).toBe(false);
  });

  it('is always satisfied for a transport with no path concept', () => {
    expect(pathSurvivesLink('tcp', '')).toBe(true);
    expect(pathSurvivesLink('grpc', '')).toBe(true);
  });
});

describe('the schema normalises the path it stores', () => {
  it('stores the default for an empty ws path — the live bug', () => {
    const parsed = vlessParamsSchema.parse({ ...base, path: '' });
    expect(parsed.path).toBe(DEFAULT_PATH);
  });

  it('stores the default when a ws path is absent entirely', () => {
    const parsed = vlessParamsSchema.parse({ ...base });
    expect(parsed.path).toBe(DEFAULT_PATH);
  });

  it('stores the default for a bare slash', () => {
    const parsed = vlessParamsSchema.parse({ ...base, path: '/' });
    expect(parsed.path).toBe(DEFAULT_PATH);
  });

  it('preserves a real path', () => {
    const parsed = vlessParamsSchema.parse({ ...base, path: '/vp-main' });
    expect(parsed.path).toBe('/vp-main');
  });

  it('drops a leftover path on tcp', () => {
    const parsed = vlessParamsSchema.parse({ ...base, network: 'tcp', path: '/leftover' });
    expect(parsed.path).toBe('');
  });

  it('rejects a slash-less path', () => {
    const result = vlessParamsSchema.safeParse({ ...base, path: 'vp-main' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['path']);
    }
  });

  it('rejects the fingerprint trap', () => {
    expect(vlessParamsSchema.safeParse({ ...base, path: FINGERPRINT }).success).toBe(false);
  });

  it('normalises for VMess and Trojan too', () => {
    const vmess = vmessParamsSchema.parse({ ...base, path: '' });
    expect(vmess.path).toBe(DEFAULT_PATH);

    const trojan = trojanParamsSchema.parse({
      ...base,
      password: 'a-long-enough-password',
      path: '',
    });
    expect(trojan.path).toBe(DEFAULT_PATH);
  });
});

describe('what the node serves equals what the link carries', () => {
  it('the empty-path config now produces a link with a matching path', () => {
    const parsed = vlessParamsSchema.parse({ ...base, path: '' });
    const rendered = generateConfig('VLESS', parsed as never, { name: 'Test' });
    expect(linkPathFor(rendered.shareLink)).toBe(parsed.path);
  });

  it('the same holds when the path was never supplied', () => {
    const parsed = vlessParamsSchema.parse({ ...base });
    const rendered = generateConfig('VLESS', parsed as never, { name: 'Test' });
    expect(linkPathFor(rendered.shareLink)).toBe(parsed.path);
  });

  it('a real path round-trips unchanged', () => {
    const parsed = vlessParamsSchema.parse({ ...base, path: '/vp-main' });
    const rendered = generateConfig('VLESS', parsed as never, { name: 'Test' });
    expect(linkPathFor(rendered.shareLink)).toBe('/vp-main');
  });

  it('tcp carries no path in the link, matching the node', () => {
    const parsed = vlessParamsSchema.parse({ ...base, network: 'tcp', security: 'none' });
    const rendered = generateConfig('VLESS', parsed as never, { name: 'Test' });
    expect(linkPathFor(rendered.shareLink)).toBeNull();
  });
});

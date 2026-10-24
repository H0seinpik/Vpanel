import { describe, expect, it } from 'vitest';
import {
  EMPTY_RENDER_CONFIRMATIONS,
  assertRenderIsApplicable,
  decideEmptyRender,
} from '@/services/render-guard';

describe('decideEmptyRender', () => {
  it('holds on the first empty render instead of wiping the node', () => {
    const verdict = decideEmptyRender({ consecutiveEmptyRenders: 1, xrayRunning: true });
    expect(verdict.action).toBe('hold');
    expect(verdict.reason).toContain('transient');
  });

  it('names the running node when it holds, so the log shows nothing was lost', () => {
    const verdict = decideEmptyRender({ consecutiveEmptyRenders: 1, xrayRunning: true });
    expect(verdict.reason).toContain('still serving');
  });

  it('applies once the empty render has been confirmed on consecutive ticks', () => {
    const verdict = decideEmptyRender({
      consecutiveEmptyRenders: EMPTY_RENDER_CONFIRMATIONS,
      xrayRunning: true,
    });
    expect(verdict.action).toBe('apply');
    expect(verdict.reason).toContain('confirmed');
  });

  it('applies even when the node was already stopped and stays empty', () => {
    const verdict = decideEmptyRender({
      consecutiveEmptyRenders: EMPTY_RENDER_CONFIRMATIONS + 3,
      xrayRunning: false,
    });
    expect(verdict.action).toBe('apply');
  });

  it('requires more than one observation — a single read is never enough', () => {
    expect(EMPTY_RENDER_CONFIRMATIONS).toBeGreaterThan(1);
    for (let n = 1; n < EMPTY_RENDER_CONFIRMATIONS; n++) {
      expect(decideEmptyRender({ consecutiveEmptyRenders: n, xrayRunning: true }).action).toBe('hold');
    }
  });
});

describe('assertRenderIsApplicable', () => {
  const good = {
    inbounds: [{ port: 443, protocol: 'vless' }],
    outbounds: [{ protocol: 'freedom' }],
  };

  it('accepts a normal render', () => {
    expect(assertRenderIsApplicable(good)).toEqual({ ok: true });
  });

  it('accepts a render that also carries the stats api inbound', () => {
    const withApi = {
      inbounds: [
        { port: 10085, protocol: 'dokodemo-door' },
        { port: 443, protocol: 'vless' },
      ],
      outbounds: [{ protocol: 'freedom' }],
    };
    expect(assertRenderIsApplicable(withApi)).toEqual({ ok: true });
  });

  it('rejects a null config', () => {
    const result = assertRenderIsApplicable(null);
    expect(result.ok).toBe(false);
  });

  it('rejects a render with no inbounds', () => {
    const result = assertRenderIsApplicable({ inbounds: [], outbounds: [{ protocol: 'freedom' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no inbounds');
  });

  it('rejects a render whose inbounds have no real port', () => {
    const result = assertRenderIsApplicable({
      inbounds: [{ protocol: 'vless' }],
      outbounds: [{ protocol: 'freedom' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('real port');
  });

  it('rejects a render with no outbound, which Xray will not start on', () => {
    const result = assertRenderIsApplicable({ inbounds: [{ port: 443 }], outbounds: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no outbound');
  });

  it('rejects a bare array or primitive', () => {
    expect(assertRenderIsApplicable([]).ok).toBe(false);
    expect(assertRenderIsApplicable('nope').ok).toBe(false);
  });
});

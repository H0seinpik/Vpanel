import { describe, expect, it } from 'vitest';
import { computeWindowTotals, type ClientBaseline } from '../src/server/services/xray-service';

/**
 * The node reports counters that only ever increase (until it restarts), while
 * the ledger expects the running total *for the current window*. These tests
 * pin that conversion down, because getting it wrong silently discards traffic
 * rather than failing loudly.
 */

const EMAIL = 'vp-assignment-1';
const WINDOW_A = '2026-09-27T06:30';
const WINDOW_B = '2026-09-27T06:31';

function counters(up: number, down: number) {
  return new Map([[EMAIL, { up: BigInt(up), down: BigInt(down) }]]);
}

describe('computeWindowTotals', () => {
  it('reports everything the node has counted on first sighting', () => {
    // The node counter is cumulative from process start, so a client we have
    // never recorded owes all of it. Treating the current value as the baseline
    // would throw away traffic that arrived before the first collection.
    const { samples, snapshot } = computeWindowTotals(counters(500, 200), {}, WINDOW_A);

    expect(samples).toHaveLength(1);
    expect(samples[0]!.uploadBytes).toBe(500n);
    expect(samples[0]!.downloadBytes).toBe(200n);
    expect(snapshot[EMAIL]).toEqual({
      rawUp: '500',
      rawDown: '200',
      baseUp: '0',
      baseDown: '0',
      windowKey: WINDOW_A,
    });
  });

  it('reports the window total, not the delta, on repeated collections', () => {
    const first = computeWindowTotals(counters(500, 200), {}, WINDOW_A);

    // 1000 more bytes arrive, collected again inside the SAME window.
    const second = computeWindowTotals(counters(1500, 200), first.snapshot, WINDOW_A);

    // The sample must be the total for the window (1500), not the increment.
    expect(second.samples).toHaveLength(1);
    expect(second.samples[0]!.uploadBytes).toBe(1500n);

    const third = computeWindowTotals(counters(1800, 200), second.snapshot, WINDOW_A);
    expect(third.samples[0]!.uploadBytes).toBe(1800n);
  });

  it('keeps reporting the cumulative window total across many collections', () => {
    // Four collections inside one minute window — the reconcile worker runs
    // every 15s, so this is the normal case, not an edge case.
    let state: Record<string, ClientBaseline> = {};
    const reported: bigint[] = [];

    for (const up of [0, 250, 600, 1000]) {
      const result = computeWindowTotals(counters(up, 0), state, WINDOW_A);
      state = result.snapshot;
      if (result.samples.length > 0) reported.push(result.samples[0]!.uploadBytes);
    }

    // The ledger applies only the difference against the existing row, so this
    // sequence must land on exactly 1000 bytes rather than 250 + 600 + 1000.
    expect(reported).toEqual([250n, 600n, 1000n]);
    expect(reported[reported.length - 1]).toBe(1000n);
  });

  it('carries the boundary traffic into the new window on rollover', () => {
    const first = computeWindowTotals(counters(1000, 0), {}, WINDOW_A);
    const next = computeWindowTotals(counters(1300, 0), first.snapshot, WINDOW_B);

    // The 300 bytes arrived between the two collections and cannot be placed
    // more precisely than "somewhere around the boundary". Attributing them to
    // the new window keeps the total correct; resetting the baseline here would
    // lose them entirely.
    expect(next.samples).toHaveLength(1);
    expect(next.samples[0]!.uploadBytes).toBe(300n);
    expect(next.snapshot[EMAIL]!.baseUp).toBe('1000');
    expect(next.snapshot[EMAIL]!.windowKey).toBe(WINDOW_B);
  });

  it('preserves traffic already recorded when the node restarts', () => {
    // 800 bytes recorded in this window, then Xray restarts and the counter
    // goes back to zero. 200 more bytes arrive afterwards.
    const before: Record<string, ClientBaseline> = {
      [EMAIL]: {
        rawUp: '800',
        rawDown: '0',
        baseUp: '0',
        baseDown: '0',
        windowKey: WINDOW_A,
      },
    };

    const after = computeWindowTotals(counters(200, 0), before, WINDOW_A);

    // The window total must be 800 + 200, not 200 — otherwise the restart
    // would make the ledger walk backwards and lose the earlier bytes.
    expect(after.samples[0]!.uploadBytes).toBe(1000n);
    expect(after.snapshot[EMAIL]!.baseUp).toBe('-800');
  });

  it('re-reports the same window total when nothing changed', () => {
    const first = computeWindowTotals(counters(700, 300), {}, WINDOW_A);
    const second = computeWindowTotals(counters(700, 300), first.snapshot, WINDOW_A);

    // The collector always states the window total; `recordTrafficSamples`
    // looks up the existing row and applies only the difference, so this
    // second report contributes 0. Keeping it unconditional is what makes a
    // failed write self-heal on the next pass instead of losing the bytes.
    expect(second.samples[0]!.uploadBytes).toBe(700n);
    expect(second.snapshot[EMAIL]!.windowKey).toBe(WINDOW_A);
  });

  it('tracks uplink and downlink independently', () => {
    const first = computeWindowTotals(counters(0, 0), {}, WINDOW_A);
    const second = computeWindowTotals(counters(400, 900), first.snapshot, WINDOW_A);

    expect(second.samples[0]!.uploadBytes).toBe(400n);
    expect(second.samples[0]!.downloadBytes).toBe(900n);
  });
});

import { describe, it, expect } from 'vitest';
import { watchdogAllowanceMs } from '../workers/index';

/**
 * The watchdog's threshold rule.
 *
 * A first version used a flat 90 s. `traffic` runs every 120 s, so a perfectly
 * healthy loop is silent for up to two minutes — the watchdog declared it wedged
 * and restarted the worker every couple of minutes. These tests pin the rule that
 * makes that impossible: the allowance must always exceed the job's own interval.
 */
describe('watchdogAllowanceMs', () => {
  const INTERVALS = {
    xray: 15_000,
    traffic: 120_000,
    monitor: 60_000,
    enforce: 600_000,
  };

  it('always exceeds the interval it watches — the bug that caused restarts', () => {
    for (const [name, ms] of Object.entries(INTERVALS)) {
      expect(watchdogAllowanceMs(ms), `${name} (${ms}ms)`).toBeGreaterThan(ms);
    }
  });

  it('tolerates at least three missed periods', () => {
    for (const ms of Object.values(INTERVALS)) {
      expect(watchdogAllowanceMs(ms)).toBeGreaterThanOrEqual(ms * 3);
    }
  });

  it('gives the 15 s reconcile job 75 s', () => {
    expect(watchdogAllowanceMs(15_000)).toBe(75_000);
  });

  it('gives the 120 s traffic job 390 s — not 90 s', () => {
    expect(watchdogAllowanceMs(120_000)).toBe(390_000);
  });

  it('scales monotonically, so a slower job is never judged more harshly', () => {
    const ordered = [15_000, 60_000, 120_000, 600_000];
    for (let i = 1; i < ordered.length; i++) {
      expect(watchdogAllowanceMs(ordered[i])).toBeGreaterThan(
        watchdogAllowanceMs(ordered[i - 1]),
      );
    }
  });

  it('handles a degenerate interval without producing a zero allowance', () => {
    expect(watchdogAllowanceMs(0)).toBeGreaterThan(0);
  });
});

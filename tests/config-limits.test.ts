import { describe, expect, it } from 'vitest';
import { ConfigStatus } from '@prisma/client';
import { evaluateConfigStatus } from '@/server/services/status-service';
import { formatRemaining, remainingBytes } from '@/lib/format';

/**
 * Configuration-level traffic ceiling.
 *
 * This is the rule that decides whether a configuration keeps serving, so the
 * boundaries matter: the wrong answer either cuts a paying user off early or
 * leaves a configuration running past its allowance.
 */

const GB = 1024n ** 3n;
const MB = 1024n ** 2n;

describe('evaluateConfigStatus', () => {
  it('leaves an under-limit configuration alone', () => {
    expect(
      evaluateConfigStatus({
        status: ConfigStatus.ACTIVE,
        trafficUsedBytes: 5n * GB,
        trafficLimitBytes: 10n * GB,
      }),
    ).toBeNull();
  });

  it('stops a configuration exactly at its limit', () => {
    // "at the limit" counts as reached - the user asked for the ceiling to be
    // the criterion, and allowing one more byte would be arbitrary.
    expect(
      evaluateConfigStatus({
        status: ConfigStatus.ACTIVE,
        trafficUsedBytes: 10n * GB,
        trafficLimitBytes: 10n * GB,
      }),
    ).toBe(ConfigStatus.TRAFFIC_EXCEEDED);
  });

  it('stops a configuration past its limit', () => {
    expect(
      evaluateConfigStatus({
        status: ConfigStatus.ACTIVE,
        trafficUsedBytes: 11n * GB,
        trafficLimitBytes: 10n * GB,
      }),
    ).toBe(ConfigStatus.TRAFFIC_EXCEEDED);
  });

  it('never stops a configuration without a limit', () => {
    expect(
      evaluateConfigStatus({
        status: ConfigStatus.ACTIVE,
        trafficUsedBytes: 999n * GB,
        trafficLimitBytes: null,
      }),
    ).toBeNull();
  });

  it('resumes a stopped configuration once it is back under the limit', () => {
    expect(
      evaluateConfigStatus({
        status: ConfigStatus.TRAFFIC_EXCEEDED,
        trafficUsedBytes: 3n * GB,
        trafficLimitBytes: 10n * GB,
      }),
    ).toBe(ConfigStatus.ACTIVE);
  });

  it('releases a stopped configuration when the limit is removed', () => {
    expect(
      evaluateConfigStatus({
        status: ConfigStatus.TRAFFIC_EXCEEDED,
        trafficUsedBytes: 500n * GB,
        trafficLimitBytes: null,
      }),
    ).toBe(ConfigStatus.ACTIVE);
  });

  it('never touches a manually DISABLED configuration', () => {
    // The operator asked for this. Auto-reverting it would be a bug.
    expect(
      evaluateConfigStatus({
        status: ConfigStatus.DISABLED,
        trafficUsedBytes: 999n * GB,
        trafficLimitBytes: 1n * GB,
      }),
    ).toBeNull();
  });

  it('never touches an EXPIRED configuration', () => {
    expect(
      evaluateConfigStatus({
        status: ConfigStatus.EXPIRED,
        trafficUsedBytes: 0n,
        trafficLimitBytes: 10n * GB,
      }),
    ).toBeNull();
  });

  it('works with sub-gigabyte limits', () => {
    expect(
      evaluateConfigStatus({
        status: ConfigStatus.ACTIVE,
        trafficUsedBytes: 512n * MB,
        trafficLimitBytes: 500n * MB,
      }),
    ).toBe(ConfigStatus.TRAFFIC_EXCEEDED);

    expect(
      evaluateConfigStatus({
        status: ConfigStatus.ACTIVE,
        trafficUsedBytes: 400n * MB,
        trafficLimitBytes: 500n * MB,
      }),
    ).toBeNull();
  });
});

/**
 * The "X left" figure shown in the panel. The operator reads this to know how
 * much a customer still has, so the boundaries must never mislead — in
 * particular it must never read as credit after the ceiling is passed.
 */
describe('remaining allowance', () => {
  it('subtracts usage from the ceiling', () => {
    expect(remainingBytes(5n * GB, 10n * GB)).toBe(Number(5n * GB));
  });

  it('never goes negative once the ceiling is passed', () => {
    expect(remainingBytes(12n * GB, 10n * GB)).toBe(0);
  });

  it('is null (unlimited) when there is no ceiling', () => {
    expect(remainingBytes(5n * GB, null)).toBeNull();
    expect(formatRemaining(5n * GB, null)).toBe('Unlimited');
  });

  it('formats a human-readable "left" label', () => {
    // 10 GB ceiling with 665 MB used -> 9.35 GB left.
    expect(formatRemaining(665n * MB, 10n * GB)).toBe('9.35 GB left');
  });

  it('shows the whole ceiling when nothing has been used', () => {
    expect(formatRemaining(0, 10n * GB)).toBe('10.00 GB left');
  });
});

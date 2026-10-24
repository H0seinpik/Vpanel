import { describe, expect, it } from 'vitest';
import { UserRole, UserStatus } from '@prisma/client';
import { evaluateUserStatus, isUsable } from '@/server/services/status-service';
import { bytesToGb, daysUntil, formatBytes, gbToBytes, textProgressBar } from '@/lib/format';
import { percentOf } from '@/lib/utils';

/**
 * Traffic accounting and quota-enforcement tests.
 *
 * These verify the rules that decide whether an account is usable — the same
 * logic the background worker applies on every enforcement pass.
 */

const GB = 1024n ** 3n;

describe('byte formatting', () => {
  it('formats zero and nullish values', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('formats across units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 ** 2)).toBe('1.00 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB');
    expect(formatBytes(5n * GB)).toBe('5.00 GB');
  });

  it('round-trips gigabytes through bytes', () => {
    expect(gbToBytes(100)).toBe(100n * GB);
    expect(bytesToGb(100n * GB)).toBe(100);
  });
});

describe('percentOf', () => {
  it('returns 0 for an unlimited allowance', () => {
    expect(percentOf(500n * GB, null)).toBe(0);
  });

  it('computes the used percentage', () => {
    expect(percentOf(25n * GB, 100n * GB)).toBe(25);
    expect(percentOf(50n * GB, 100n * GB)).toBe(50);
  });

  it('clamps at 100 when over quota', () => {
    expect(percentOf(150n * GB, 100n * GB)).toBe(100);
  });

  it('guards against a zero allowance', () => {
    expect(percentOf(10n * GB, 0n)).toBe(0);
  });
});

describe('textProgressBar', () => {
  it('renders an eight-of-ten bar at 80%', () => {
    expect(textProgressBar(80)).toBe('████████░░');
  });

  it('renders full and empty bars', () => {
    expect(textProgressBar(100)).toBe('██████████');
    expect(textProgressBar(0)).toBe('░░░░░░░░░░');
  });
});

describe('evaluateUserStatus', () => {
  const base = {
    status: UserStatus.ACTIVE,
    expirationDate: null as Date | null,
    trafficUsedBytes: 0n,
    trafficLimitBytes: null as bigint | null,
  };

  it('stays ACTIVE when within quota and not expired', () => {
    const result = evaluateUserStatus({
      ...base,
      trafficUsedBytes: 10n * GB,
      trafficLimitBytes: 100n * GB,
      expirationDate: new Date(Date.now() + 10 * 86_400_000),
    });
    expect(result.status).toBe(UserStatus.ACTIVE);
    expect(result.reason).toBeNull();
  });

  it('marks an account EXPIRED once the date has passed', () => {
    const result = evaluateUserStatus({
      ...base,
      expirationDate: new Date(Date.now() - 86_400_000),
    });
    expect(result.status).toBe(UserStatus.EXPIRED);
    expect(result.reason).toMatch(/expiration/i);
  });

  it('marks an account TRAFFIC_EXCEEDED exactly at the limit', () => {
    const result = evaluateUserStatus({
      ...base,
      trafficUsedBytes: 100n * GB,
      trafficLimitBytes: 100n * GB,
    });
    expect(result.status).toBe(UserStatus.TRAFFIC_EXCEEDED);
  });

  it('marks an account TRAFFIC_EXCEEDED when over the limit', () => {
    const result = evaluateUserStatus({
      ...base,
      trafficUsedBytes: 120n * GB,
      trafficLimitBytes: 100n * GB,
    });
    expect(result.status).toBe(UserStatus.TRAFFIC_EXCEEDED);
  });

  it('never overrides a manual DISABLED decision', () => {
    const result = evaluateUserStatus({
      ...base,
      status: UserStatus.DISABLED,
      trafficUsedBytes: 0n,
      expirationDate: null,
    });
    expect(result.status).toBe(UserStatus.DISABLED);
  });

  it('never overrides a manual SUSPENDED decision, even when expired', () => {
    const result = evaluateUserStatus({
      ...base,
      status: UserStatus.SUSPENDED,
      expirationDate: new Date(Date.now() - 86_400_000),
    });
    expect(result.status).toBe(UserStatus.SUSPENDED);
  });

  it('prefers EXPIRED over TRAFFIC_EXCEEDED when both apply', () => {
    const result = evaluateUserStatus({
      ...base,
      expirationDate: new Date(Date.now() - 86_400_000),
      trafficUsedBytes: 200n * GB,
      trafficLimitBytes: 100n * GB,
    });
    expect(result.status).toBe(UserStatus.EXPIRED);
  });

  it('treats an unlimited account with no expiry as ACTIVE', () => {
    const result = evaluateUserStatus({
      ...base,
      trafficUsedBytes: 900n * GB,
      trafficLimitBytes: null,
      expirationDate: null,
    });
    expect(result.status).toBe(UserStatus.ACTIVE);
  });
});

describe('staff exemption', () => {
  // An administrator must never be locked out of the panel by a quota that was
  // applied to a configuration, or by an expiry date someone set on their own
  // account. These are the two ways that used to happen.
  it('never marks an ADMIN as TRAFFIC_EXCEEDED', () => {
    const result = evaluateUserStatus({
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      expirationDate: null,
      trafficUsedBytes: 500n * GB,
      trafficLimitBytes: 10n * GB,
    });
    expect(result.status).toBe(UserStatus.ACTIVE);
    expect(result.reason).toBeNull();
  });

  it('never marks an ADMIN as EXPIRED', () => {
    const result = evaluateUserStatus({
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      expirationDate: new Date(Date.now() - 30 * 86_400_000),
      trafficUsedBytes: 0n,
      trafficLimitBytes: null,
    });
    expect(result.status).toBe(UserStatus.ACTIVE);
  });

  it('exempts OPERATOR accounts too', () => {
    const result = evaluateUserStatus({
      role: UserRole.OPERATOR,
      status: UserStatus.ACTIVE,
      expirationDate: new Date(Date.now() - 86_400_000),
      trafficUsedBytes: 900n * GB,
      trafficLimitBytes: 1n * GB,
    });
    expect(result.status).toBe(UserStatus.ACTIVE);
  });

  it('still applies the rules to ordinary users', () => {
    const result = evaluateUserStatus({
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
      expirationDate: null,
      trafficUsedBytes: 500n * GB,
      trafficLimitBytes: 10n * GB,
    });
    expect(result.status).toBe(UserStatus.TRAFFIC_EXCEEDED);
  });

  it('still lets an administrator disable their own account manually', () => {
    // The exemption covers automatic enforcement only. A deliberate disable
    // must stick, otherwise the panel would silently re-enable an account an
    // administrator had switched off.
    const result = evaluateUserStatus({
      role: UserRole.ADMIN,
      status: UserStatus.DISABLED,
      expirationDate: null,
      trafficUsedBytes: 0n,
      trafficLimitBytes: null,
    });
    expect(result.status).toBe(UserStatus.DISABLED);
  });
});

describe('isUsable', () => {
  it('only ACTIVE accounts may use their configuration', () => {
    expect(isUsable(UserStatus.ACTIVE)).toBe(true);
    expect(isUsable(UserStatus.EXPIRED)).toBe(false);
    expect(isUsable(UserStatus.TRAFFIC_EXCEEDED)).toBe(false);
    expect(isUsable(UserStatus.DISABLED)).toBe(false);
    expect(isUsable(UserStatus.SUSPENDED)).toBe(false);
  });
});

describe('daysUntil', () => {
  it('returns null without a date', () => {
    expect(daysUntil(null)).toBeNull();
  });

  it('returns a positive count for future dates', () => {
    const days = daysUntil(new Date(Date.now() + 15 * 86_400_000));
    expect(days).toBe(15);
  });

  it('returns a negative count for past dates', () => {
    const days = daysUntil(new Date(Date.now() - 3 * 86_400_000));
    expect(days).toBeLessThan(0);
  });
});

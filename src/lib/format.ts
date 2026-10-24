/**
 * Byte / date / currency formatting helpers shared by server and client code.
 * Byte math uses BigInt so traffic counters never lose precision.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Format a byte count as a human-readable string (base 1024). */
export function formatBytes(bytes: number | bigint | null | undefined, decimals = 2): string {
  if (bytes === null || bytes === undefined) return '—';
  const value = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (!Number.isFinite(value) || value <= 0) return '0 B';

  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const scaled = value / 1024 ** exponent;
  const rounded = scaled.toFixed(exponent === 0 ? 0 : decimals);
  return `${rounded} ${BYTE_UNITS[exponent]}`;
}

/** Convert gigabytes to bytes (BigInt) for storage. */
export function gbToBytes(gb: number): bigint {
  return BigInt(Math.round(gb * 1024 ** 3));
}

/**
 * Convert megabytes to bytes (BigInt) for storage.
 *
 * Small allowances are more natural to express in MB, so the UI offers both
 * units and the service converts whichever it receives.
 */
export function mbToBytes(mb: number): bigint {
  return BigInt(Math.round(mb * 1024 ** 2));
}

/** Format a byte allowance the way a human would have entered it. */
export function formatAllowance(bytes: number | bigint | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'Unlimited';
  const value = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (value <= 0) return 'Unlimited';
  // Under 1 GB reads better in MB.
  if (value < 1024 ** 3) {
    const mb = value / 1024 ** 2;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return formatBytes(value);
}

/**
 * Bytes still available before a ceiling is reached (null = unlimited).
 *
 * Never negative: a configuration that has overshot its allowance reports `0`,
 * not a negative number, so the "left" figure can never look like credit.
 */
export function remainingBytes(
  used: number | bigint | null | undefined,
  limit: number | bigint | null | undefined,
): number | null {
  if (limit === null || limit === undefined) return null;
  const limitValue = typeof limit === 'bigint' ? Number(limit) : limit;
  if (!Number.isFinite(limitValue) || limitValue <= 0) return null;
  const usedValue =
    used === null || used === undefined ? 0 : typeof used === 'bigint' ? Number(used) : used;
  const safeUsed = Number.isFinite(usedValue) ? usedValue : 0;
  return Math.max(0, limitValue - safeUsed);
}

/**
 * "9.4 GB left" / "Unlimited" — the remaining allowance of a configuration.
 *
 * This is the number the operator actually cares about ("how much is left?"),
 * so it is shown next to the used/limit pair rather than replacing it.
 */
export function formatRemaining(
  used: number | bigint | null | undefined,
  limit: number | bigint | null | undefined,
): string {
  const remaining = remainingBytes(used, limit);
  if (remaining === null) return 'Unlimited';
  return `${formatBytes(remaining)} left`;
}

/** Convert bytes to gigabytes as a number (for chart axes). */
export function bytesToGb(bytes: number | bigint | null | undefined): number {
  if (bytes === null || bytes === undefined) return 0;
  const value = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  return Number((value / 1024 ** 3).toFixed(3));
}

export function formatCurrency(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: '2-digit' });
}

export function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "in 15 days" / "3 days ago" style relative labels. */
export function formatRelative(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';

  const diffMs = d.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const day = 86_400_000;
  const hour = 3_600_000;
  const minute = 60_000;

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs >= day) return rtf.format(Math.round(diffMs / day), 'day');
  if (abs >= hour) return rtf.format(Math.round(diffMs / hour), 'hour');
  if (abs >= minute) return rtf.format(Math.round(diffMs / minute), 'minute');
  return rtf.format(Math.round(diffMs / 1000), 'second');
}

/** Days remaining until `date` (negative when already past). */
export function daysUntil(date: Date | string | null | undefined): number | null {
  if (!date) return null;
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

/** Render a text progress bar, e.g. `████████░░ 80%`. */
export function textProgressBar(percent: number, width = 10): string {
  const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

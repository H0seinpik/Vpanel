import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind-aware className merge used by every UI primitive. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Clamp a number into an inclusive range. */
export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Percentage of `used` against `total`; null total means unlimited (0%). */
export function percentOf(used: number | bigint, total: number | bigint | null | undefined) {
  const u = Number(used);
  if (total === null || total === undefined) return 0;
  const t = Number(total);
  if (t <= 0) return 0;
  return clamp((u / t) * 100, 0, 100);
}

/** Remove keys with `undefined` values — handy before Prisma updates. */
export function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** First N chars + ellipsis, safe for nullish input. */
export function truncate(value: string | null | undefined, length = 40) {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

import crypto from 'node:crypto';
import { getEnv } from './env';

/**
 * Symmetric helpers. Secrets always come from the environment — nothing is
 * hard-coded. `APP_SECRET` is derived from the refresh secret so operators only
 * manage one extra value.
 */

function appKey(): Buffer {
  const env = getEnv();
  return crypto.createHash('sha256').update(`${env.JWT_REFRESH_SECRET}:app`).digest();
}

/** Hex-encoded SHA-256 hash — used for refresh tokens and dedupe keys. */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** AES-256-GCM encryption for at-rest credentials (e.g. agent tokens). */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', appKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', appKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** URL-safe random token (used for refresh tokens, device keys, subscription ids). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomUuid(): string {
  return crypto.randomUUID();
}

/** Mask a credential for display: keeps first/last 4 chars. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return '—';
  if (value.length <= 10) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

import bcrypt from 'bcryptjs';

/**
 * Password hashing. bcrypt with a cost factor of 12 is used because it is
 * available as a pure-JS dependency (no native build step in Docker) while
 * remaining a slow, salted, industry-standard KDF.
 *
 * `hashPassword` is the ONLY place a plaintext password should ever be seen —
 * it is never logged, never returned by an API, and never stored.
 */

const BCRYPT_COST = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!plaintext || !hash) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/**
 * Password policy enforced server-side (the UI mirrors it, but the API is the
 * authority). Requires length + character diversity without being punitive.
 */
export function validatePasswordStrength(password: string): { ok: boolean; message?: string } {
  if (password.length < 8) return { ok: false, message: 'Password must be at least 8 characters.' };
  if (password.length > 128) return { ok: false, message: 'Password must be under 128 characters.' };
  if (!/[a-z]/.test(password)) return { ok: false, message: 'Include at least one lowercase letter.' };
  if (!/[A-Z]/.test(password)) return { ok: false, message: 'Include at least one uppercase letter.' };
  if (!/[0-9]/.test(password)) return { ok: false, message: 'Include at least one number.' };
  return { ok: true };
}

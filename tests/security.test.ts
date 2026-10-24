import { describe, expect, it } from 'vitest';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { hashPassword, validatePasswordStrength, verifyPassword } from '@/lib/auth/password';
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from '@/lib/auth/tokens';
import { decryptSecret, encryptSecret, maskSecret, safeEqual, sha256 } from '@/lib/crypto';
import { AppError, ConflictError, ForbiddenError, NotFoundError, toAppError, ValidationError } from '@/lib/api/errors';
import { paginate, parsePagination } from '@/lib/api/response';
import { rateLimit, resetRateLimiter } from '@/lib/rate-limit';
import { sanitizeText } from '@/lib/validation';

/**
 * Security-layer tests: password hashing, token type separation, at-rest
 * encryption, error mapping, pagination bounds and rate limiting.
 */

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('Correct_Horse_1');
    expect(hash).not.toContain('Correct_Horse_1');
    expect(await verifyPassword('Correct_Horse_1', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('Correct_Horse_1');
    expect(await verifyPassword('Wrong_Horse_1', hash)).toBe(false);
  });

  it('produces a different hash each time (unique salt)', async () => {
    const first = await hashPassword('Same_Password_1');
    const second = await hashPassword('Same_Password_1');
    expect(first).not.toBe(second);
  });

  it('refuses to hash a short password', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});

describe('password strength policy', () => {
  it('accepts a strong password', () => {
    expect(validatePasswordStrength('Str0ng_Password').ok).toBe(true);
  });

  it('rejects passwords missing a character class', () => {
    expect(validatePasswordStrength('alllowercase1').ok).toBe(false);
    expect(validatePasswordStrength('ALLUPPERCASE1').ok).toBe(false);
    expect(validatePasswordStrength('NoNumbersHere').ok).toBe(false);
    expect(validatePasswordStrength('Sh0rt').ok).toBe(false);
  });
});

describe('JWT tokens', () => {
  const user = { userId: 'user-1', role: UserRole.ADMIN, username: 'admin', sessionId: 'session-1' };

  it('round-trips an access token', () => {
    const token = signAccessToken(user);
    const payload = verifyAccessToken(token);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.role).toBe(UserRole.ADMIN);
    expect(payload?.typ).toBe('access');
  });

  it('round-trips a refresh token', () => {
    const token = signRefreshToken({ userId: 'user-1', sessionId: 'session-1' });
    const payload = verifyRefreshToken(token);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.sid).toBe('session-1');
  });

  it('rejects a refresh token where an access token is expected', () => {
    const refresh = signRefreshToken({ userId: 'user-1', sessionId: 'session-1' });
    expect(verifyAccessToken(refresh)).toBeNull();
  });

  it('rejects an access token where a refresh token is expected', () => {
    const access = signAccessToken(user);
    expect(verifyRefreshToken(access)).toBeNull();
  });

  it('rejects a tampered token', () => {
    const token = signAccessToken(user);
    expect(verifyAccessToken(`${token}tampered`)).toBeNull();
    expect(verifyAccessToken('not.a.token')).toBeNull();
  });
});

describe('at-rest encryption', () => {
  it('round-trips a secret', () => {
    const secret = 'agent-token-abcdef123456';
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('throws on a malformed payload', () => {
    expect(() => decryptSecret('garbage')).toThrow();
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const encrypted = encryptSecret('secret-value');
    const [iv, tag, data] = encrypted.split(':');
    const tampered = `${iv}:${tag}:${Buffer.from('different').toString('base64')}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe('hashing helpers', () => {
  it('produces a stable SHA-256 hash', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abd'));
    expect(sha256('abc')).toHaveLength(64);
  });

  it('compares strings in constant time', () => {
    expect(safeEqual('token', 'token')).toBe(true);
    expect(safeEqual('token', 'other')).toBe(false);
    expect(safeEqual('short', 'longer-value')).toBe(false);
  });

  it('masks secrets for display', () => {
    expect(maskSecret('1234567890abcdef')).toBe('1234••••cdef');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret(null)).toBe('—');
  });
});

describe('error mapping', () => {
  it('passes AppError through unchanged', () => {
    const original = new ForbiddenError('nope');
    expect(toAppError(original)).toBe(original);
  });

  it('maps a ZodError to a ValidationError', () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const mapped = toAppError(parsed.error);
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped.status).toBe(422);
  });

  it('maps a structurally-identical ZodError from another module copy', () => {
    // Guards against duplicate zod instances in the module graph.
    const foreign = Object.assign(new Error('validation'), {
      name: 'ZodError',
      issues: [{ path: ['email'], message: 'Required' }],
    });
    const mapped = toAppError(foreign);
    expect(mapped).toBeInstanceOf(ValidationError);
    expect(mapped.status).toBe(422);
  });

  it('maps Prisma unique violations to 409', () => {
    const mapped = toAppError({ code: 'P2002' });
    expect(mapped).toBeInstanceOf(ConflictError);
    expect(mapped.status).toBe(409);
  });

  it('maps Prisma not-found to 404', () => {
    expect(toAppError({ code: 'P2025' }).status).toBe(404);
    expect(toAppError({ code: 'P2025' })).toBeInstanceOf(NotFoundError);
  });

  it('never leaks internals for an unknown error', () => {
    const mapped = toAppError(new Error('secret database detail'));
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.status).toBe(500);
    expect(mapped.message).not.toContain('secret database detail');
  });
});

describe('pagination', () => {
  it('parses sane defaults', () => {
    const result = parsePagination(new URL('http://localhost/api/users'));
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.skip).toBe(0);
  });

  it('clamps the page size to the maximum', () => {
    const result = parsePagination(new URL('http://localhost/api/users?pageSize=5000'));
    expect(result.pageSize).toBe(100);
  });

  it('never returns a negative page', () => {
    const result = parsePagination(new URL('http://localhost/api/users?page=-5'));
    expect(result.page).toBe(1);
    expect(result.skip).toBe(0);
  });

  it('computes page metadata', () => {
    const meta = paginate([1, 2], 45, 2, 20);
    expect(meta.pagination.totalPages).toBe(3);
    expect(meta.pagination.hasNext).toBe(true);
    expect(meta.pagination.hasPrev).toBe(true);
  });

  it('reports no next page on the final page', () => {
    const meta = paginate([1], 45, 3, 20);
    expect(meta.pagination.hasNext).toBe(false);
  });
});

describe('rate limiting', () => {
  it('allows requests up to the limit, then blocks', async () => {
    resetRateLimiter();
    const options = { limit: 3, windowMs: 60_000 };

    const first = await rateLimit('test:key', options);
    const second = await rateLimit('test:key', options);
    const third = await rateLimit('test:key', options);
    const fourth = await rateLimit('test:key', options);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(third.success).toBe(true);
    expect(fourth.success).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('tracks separate buckets independently', async () => {
    resetRateLimiter();
    const options = { limit: 1, windowMs: 60_000 };
    await rateLimit('bucket:a', options);
    const other = await rateLimit('bucket:b', options);
    expect(other.success).toBe(true);
  });
});

describe('input sanitisation', () => {
  it('strips control characters and trims', () => {
    expect(sanitizeText('  hello\u0000world\u001f  ')).toBe('helloworld');
  });

  it('leaves normal text intact', () => {
    expect(sanitizeText('Germany Node 01')).toBe('Germany Node 01');
  });
});

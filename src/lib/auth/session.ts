import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import type { UserRole, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { randomToken, sha256 } from '@/lib/crypto';
import { authCookieOptions } from './cookie-policy';
import {
  accessTokenTtlSeconds,
  refreshTokenTtlSeconds,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './tokens';

/**
 * Session management.
 *
 *  - Access + refresh tokens live in httpOnly, SameSite=Lax cookies.
 *  - Refresh tokens are stored HASHED (SHA-256) in `sessions` and rotated on
 *    every use. Presenting a stale refresh token (hash mismatch) is treated as
 *    a theft signal and revokes the whole session chain for that user.
 *  - The session id is stable across rotations so live access tokens stay valid.
 */

export const ACCESS_COOKIE = 'vpanel_at';
export const REFRESH_COOKIE = 'vpanel_rt';

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  status: UserStatus;
  expirationDate: Date | null;
  trafficUsedBytes: bigint;
  trafficLimitBytes: bigint | null;
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

/** Statuses allowed to authenticate into the panel at all. */
const LOGIN_ALLOWED_STATUSES: UserStatus[] = ['ACTIVE', 'EXPIRED', 'TRAFFIC_EXCEEDED'];

export function isLoginAllowed(status: UserStatus): boolean {
  return LOGIN_ALLOWED_STATUSES.includes(status);
}

// -----------------------------------------------------------------------------
// Session lifecycle
// -----------------------------------------------------------------------------

export async function createSession(
  user: { id: string; role: UserRole; username: string },
  meta: RequestMeta = {},
): Promise<IssuedTokens> {
  const sessionId = randomToken(18);
  const refreshToken = signRefreshToken({ userId: user.id, sessionId });
  const refreshExpiresAt = new Date(Date.now() + refreshTokenTtlSeconds() * 1000);

  await prisma.session.create({
    data: {
      id: sessionId,
      userId: user.id,
      tokenHash: sha256(refreshToken),
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
      expiresAt: refreshExpiresAt,
    },
  });

  const accessToken = signAccessToken({
    userId: user.id,
    role: user.role,
    username: user.username,
    sessionId,
  });

  return {
    accessToken,
    refreshToken,
    sessionId,
    accessExpiresAt: new Date(Date.now() + accessTokenTtlSeconds() * 1000),
    refreshExpiresAt,
  };
}

export class RefreshRejectedError extends Error {
  constructor(message = 'Refresh token rejected.') {
    super(message);
    this.name = 'RefreshRejectedError';
  }
}

/**
 * Rotate a refresh token. Returns a brand-new token pair bound to the same
 * stable session id.
 */
export async function rotateSession(
  rawRefreshToken: string,
  meta: RequestMeta = {},
): Promise<IssuedTokens> {
  const payload = verifyRefreshToken(rawRefreshToken);
  if (!payload) throw new RefreshRejectedError('Refresh token is invalid or expired.');

  const session = await prisma.session.findUnique({
    where: { id: payload.sid },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
    throw new RefreshRejectedError('Session is no longer valid.');
  }

  // Rotation / reuse detection: the presented token must match the stored hash.
  if (session.tokenHash !== sha256(rawRefreshToken)) {
    // A previously-rotated token was replayed — revoke everything for safety.
    await prisma.session.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new RefreshRejectedError('Refresh token reuse detected; all sessions revoked.');
  }

  if (!isLoginAllowed(session.user.status)) {
    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    throw new RefreshRejectedError('Account is not permitted to sign in.');
  }

  const refreshToken = signRefreshToken({ userId: session.userId, sessionId: session.id });
  const refreshExpiresAt = new Date(Date.now() + refreshTokenTtlSeconds() * 1000);

  await prisma.session.update({
    where: { id: session.id },
    data: {
      tokenHash: sha256(refreshToken),
      lastUsedAt: new Date(),
      expiresAt: refreshExpiresAt,
      ip: meta.ip ?? session.ip,
      userAgent: meta.userAgent ?? session.userAgent,
    },
  });

  const accessToken = signAccessToken({
    userId: session.user.id,
    role: session.user.role,
    username: session.user.username,
    sessionId: session.id,
  });

  return {
    accessToken,
    refreshToken,
    sessionId: session.id,
    accessExpiresAt: new Date(Date.now() + accessTokenTtlSeconds() * 1000),
    refreshExpiresAt,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session
    .update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

function toSessionUser(user: {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  status: UserStatus;
  expirationDate: Date | null;
  trafficUsedBytes: bigint;
  trafficLimitBytes: bigint | null;
}): SessionUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    expirationDate: user.expirationDate,
    trafficUsedBytes: user.trafficUsedBytes,
    trafficLimitBytes: user.trafficLimitBytes,
  };
}

/** Resolve the current user from an access token, validating the session row. */
export async function resolveUserFromAccessToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;

  const payload = verifyAccessToken(token);
  if (!payload) return null;

  const session = await prisma.session.findUnique({
    where: { id: payload.sid },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;
  if (!isLoginAllowed(session.user.status)) return null;

  return toSessionUser(session.user);
}

/** Server-component helper: read the access cookie via next/headers. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  return resolveUserFromAccessToken(token);
}

/** Route-handler helper: read cookies straight off the request. */
export async function getSessionUserFromRequest(req: {
  cookies: { get(name: string): { value: string } | undefined };
}): Promise<SessionUser | null> {
  const token = req.cookies.get(ACCESS_COOKIE)?.value;
  return resolveUserFromAccessToken(token);
}

// -----------------------------------------------------------------------------
// Cookies
// -----------------------------------------------------------------------------

export function setAuthCookies(res: NextResponse, tokens: IssuedTokens): void {
  res.cookies.set(ACCESS_COOKIE, tokens.accessToken, authCookieOptions(accessTokenTtlSeconds()));
  res.cookies.set(REFRESH_COOKIE, tokens.refreshToken, authCookieOptions(refreshTokenTtlSeconds()));
}

export function clearAuthCookies(res: NextResponse): void {
  res.cookies.set(ACCESS_COOKIE, '', { ...authCookieOptions(0), maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, '', { ...authCookieOptions(0), maxAge: 0 });
}

/** Extract client IP / UA from a request for audit + session records. */
export function requestMeta(req: {
  headers: { get(name: string): string | null };
}): RequestMeta {
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null;
  return { ip, userAgent: req.headers.get('user-agent') };
}

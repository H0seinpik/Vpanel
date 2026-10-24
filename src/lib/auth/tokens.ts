import jwt, { type SignOptions } from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { getEnv } from '@/lib/env';

/**
 * JWT issuance/verification.
 *
 * Two token types with different secrets and lifetimes:
 *   - access  (short-lived, sent on every request)
 *   - refresh (long-lived, rotated on every use, stored hashed in the DB)
 *
 * The `typ` claim prevents a refresh token from being accepted where an access
 * token is expected, and vice versa.
 */

export interface AccessTokenPayload {
  sub: string;
  typ: 'access';
  role: UserRole;
  username: string;
  sid: string;
}

export interface RefreshTokenPayload {
  sub: string;
  typ: 'refresh';
  sid: string;
}

export function signAccessToken(input: {
  userId: string;
  role: UserRole;
  username: string;
  sessionId: string;
}): string {
  const env = getEnv();
  const payload: AccessTokenPayload = {
    sub: input.userId,
    typ: 'access',
    role: input.role,
    username: input.username,
    sid: input.sessionId,
  };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: 'vpanel',
    audience: 'vpanel-web',
  } satisfies SignOptions);
}

export function signRefreshToken(input: { userId: string; sessionId: string }): string {
  const env = getEnv();
  const payload: RefreshTokenPayload = {
    sub: input.userId,
    typ: 'refresh',
    sid: input.sessionId,
  };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
    issuer: 'vpanel',
    audience: 'vpanel-refresh',
  } satisfies SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getEnv().JWT_ACCESS_SECRET, {
      issuer: 'vpanel',
      audience: 'vpanel-web',
    }) as AccessTokenPayload;
    if (decoded.typ !== 'access') return null;
    return decoded;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getEnv().JWT_REFRESH_SECRET, {
      issuer: 'vpanel',
      audience: 'vpanel-refresh',
    }) as RefreshTokenPayload;
    if (decoded.typ !== 'refresh') return null;
    return decoded;
  } catch {
    return null;
  }
}

export function accessTokenTtlSeconds(): number {
  return getEnv().JWT_ACCESS_TTL;
}

export function refreshTokenTtlSeconds(): number {
  return getEnv().JWT_REFRESH_TTL;
}

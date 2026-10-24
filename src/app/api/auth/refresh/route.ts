import { NextResponse } from 'next/server';
import { readJson, withPublic } from '@/lib/api/handler';
import { jsonError, jsonOk } from '@/lib/api/response';
import { UnauthorizedError } from '@/lib/api/errors';
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  requestMeta,
  rotateSession,
  setAuthCookies,
} from '@/lib/auth/session';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';

/**
 * POST /api/auth/refresh
 *
 * Rotates the refresh token and issues a fresh access token. Refresh tokens are
 * single-use: presenting an already-rotated token revokes the whole session
 * chain (see `rotateSession`), which is our theft-detection mechanism.
 *
 * Accepts the token from the httpOnly cookie (browser) or the request body
 * (non-browser clients).
 */
export const POST = withPublic(
  async (req) => {
    let bodyRefresh: string | undefined;
    try {
      bodyRefresh = (await readJson<{ refreshToken?: string }>(req)).refreshToken;
    } catch {
      bodyRefresh = undefined;
    }

    const rawToken = req.cookies.get(REFRESH_COOKIE)?.value ?? bodyRefresh;

    if (!rawToken) {
      const response = jsonError(new UnauthorizedError('No refresh token supplied.'));
      clearAuthCookies(response);
      return response;
    }

    try {
      const tokens = await rotateSession(rawToken, requestMeta(req));
      const response = jsonOk({
        accessTokenExpiresAt: tokens.accessExpiresAt.toISOString(),
      }) as NextResponse;
      setAuthCookies(response, tokens);

      await recordAudit({
        action: AUDIT_ACTIONS.TOKEN_REFRESH,
        targetType: 'session',
        targetId: tokens.sessionId,
      });

      return response;
    } catch (error) {
      // Rotation failures clear the cookies so the client falls back to /login.
      const response = jsonError(error);
      clearAuthCookies(response);
      return response;
    }
  },
  { rate: 'refresh' },
);

import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { clearAuthCookies, requestMeta, revokeAllSessions } from '@/lib/auth/session';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';

/**
 * POST /api/auth/logout
 *
 * Revokes every session for the user (so no refresh token can be replayed) and
 * clears the auth cookies.
 */
export const POST = withAuth(async (req, { user }) => {
  await revokeAllSessions(user.id);

  const meta = requestMeta(req);
  await recordAudit({
    actorId: user.id,
    actorName: user.username,
    action: AUDIT_ACTIONS.LOGOUT,
    targetType: 'user',
    targetId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  const response = jsonOk({ success: true }) as NextResponse;
  clearAuthCookies(response);
  return response;
});

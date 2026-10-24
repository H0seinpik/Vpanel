import { readJson, withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { resetPasswordSchema } from '@/lib/validation';
import { resetPassword } from '@/server/services/user-service';

/**
 * POST /api/users/:id/password — administrative password reset.
 *
 * Revokes the target's sessions by default, so a compromised account cannot
 * keep an active session after the reset.
 */
export const POST = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const input = resetPasswordSchema.parse(await readJson(req));
    await resetPassword(params.id, input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return jsonOk({
      success: true,
      sessionsRevoked: input.revokeSessions !== false,
    });
  },
  { capability: 'users:reset-password', rate: 'sensitive' },
);

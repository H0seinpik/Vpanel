import { prisma } from '@/lib/prisma';
import { readJson, withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { ValidationError } from '@/lib/api/errors';
import { changePasswordSchema } from '@/lib/validation';
import { hashPassword, validatePasswordStrength, verifyPassword } from '@/lib/auth/password';
import { revokeAllSessions } from '@/lib/auth/session';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';

/**
 * POST /api/auth/password
 *
 * Self-service password change. Requires the current password, enforces the
 * strength policy, then revokes all sessions so any other device is signed out.
 */
export const POST = withAuth(
  async (req, { user, meta }) => {
    const input = changePasswordSchema.parse(await readJson(req));

    const record = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!record) throw new ValidationError('Account not found.');

    const currentValid = await verifyPassword(input.currentPassword, record.passwordHash);
    if (!currentValid) throw new ValidationError('Your current password is incorrect.');

    const strength = validatePasswordStrength(input.newPassword);
    if (!strength.ok) throw new ValidationError(strength.message ?? 'Weak password');

    if (input.currentPassword === input.newPassword) {
      throw new ValidationError('The new password must be different from the current one.');
    }

    const passwordHash = await hashPassword(input.newPassword);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    await revokeAllSessions(user.id);

    await recordAudit({
      actorId: user.id,
      actorName: user.username,
      action: AUDIT_ACTIONS.PASSWORD_RESET,
      targetType: 'user',
      targetId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: { self: true, sessionsRevoked: true },
    });

    return jsonOk({ success: true, message: 'Password updated. Please sign in again.' });
  },
  { rate: 'sensitive' },
);

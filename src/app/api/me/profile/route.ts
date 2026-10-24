import { prisma } from '@/lib/prisma';
import { readJson, withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { ConflictError } from '@/lib/api/errors';
import { updateProfileSchema } from '@/lib/validation';
import { serializeUser } from '@/server/serializers';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';

/**
 * PATCH /api/me/profile — update the caller's own display name / email.
 *
 * Role, status, quotas and expiry are NOT self-editable: those require staff
 * privileges and are handled by the admin user endpoints.
 */
export const PATCH = withAuth(async (req, { user, meta }) => {
  const input = updateProfileSchema.parse(await readJson(req));

  if (input.email && input.email !== user.email) {
    const taken = await prisma.user.findUnique({ where: { email: input.email } });
    if (taken) throw new ConflictError('That email address is already in use.');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
    },
  });

  await recordAudit({
    actorId: user.id,
    actorName: user.username,
    action: AUDIT_ACTIONS.USER_UPDATE,
    targetType: 'user',
    targetId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    metadata: { self: true, fields: Object.keys(input) },
  });

  return jsonOk(serializeUser(updated));
});

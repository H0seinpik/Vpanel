import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { isStaff } from '@/lib/auth/rbac';
import { deleteDevice, revokeDevice } from '@/server/services/device-service';

/**
 * DELETE /api/devices/:id
 *
 * A user removes their own device; staff revoke a device (which notifies the
 * owner). The distinction is enforced server-side.
 */
export const DELETE = withAuth<{ id: string }>(async (_req, { user, params, meta }) => {
  const actor = {
    id: user.id,
    username: user.username,
    role: user.role,
    ip: meta.ip,
    userAgent: meta.userAgent,
  };

  if (isStaff(user.role)) {
    const revoked = await revokeDevice(params.id, actor);
    return jsonOk({ ...revoked, revoked: true });
  }

  const deleted = await deleteDevice(params.id, user.id, actor);
  return jsonOk({ ...deleted, revoked: false });
});

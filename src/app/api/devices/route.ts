import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonOk } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/api/errors';
import { isStaff } from '@/lib/auth/rbac';
import { deviceSchema } from '@/lib/validation';
import { serializeDevice } from '@/server/serializers';
import { listDevices, registerDevice } from '@/server/services/device-service';

/**
 * GET  /api/devices           — the caller's own devices
 * GET  /api/devices?userId=…  — staff only: another user's devices
 * POST /api/devices           — register a device (self, or staff on behalf)
 *
 * Device limits come from the user's plan and are enforced in the service.
 */
export const GET = withAuth(async (req, { user }) => {
  const requested = new URL(req.url).searchParams.get('userId');
  if (requested && requested !== user.id && !isStaff(user.role)) {
    throw new ForbiddenError('You can only view your own devices.');
  }

  const devices = await listDevices(requested ?? user.id);
  return jsonOk(devices.map(serializeDevice));
});

export const POST = withAuth(async (req, { user, meta }) => {
  const body = (await readJson(req)) as Record<string, unknown>;
  const input = deviceSchema.parse(body);

  const requestedUserId = typeof body.userId === 'string' ? body.userId : undefined;
  if (requestedUserId && requestedUserId !== user.id && !isStaff(user.role)) {
    throw new ForbiddenError('You can only register devices on your own account.');
  }

  const device = await registerDevice(requestedUserId ?? user.id, {
    ...input,
    ip: meta.ip,
  });

  return jsonCreated(serializeDevice(device));
});

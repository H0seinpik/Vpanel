import { readJson, withAuth } from '@/lib/api/handler';
import { jsonNoContent, jsonOk } from '@/lib/api/response';
import { updateUserSchema } from '@/lib/validation';
import { serializeUser } from '@/server/serializers';
import { deleteUser, getUserDetail, updateUser } from '@/server/services/user-service';
import { serializeConfig, serializeDevice, serializeSubscription } from '@/server/serializers';

/**
 * GET    /api/users/:id  — full detail (users:read)
 * PATCH  /api/users/:id  — update (users:write)
 * DELETE /api/users/:id  — delete (users:delete)
 */
export const GET = withAuth<{ id: string }>(
  async (_req, { params }) => {
    const detail = await getUserDetail(params.id);

    return jsonOk({
      user: serializeUser(detail),
      plan: detail.plan
        ? { id: detail.plan.id, name: detail.plan.name, deviceLimit: detail.plan.deviceLimit }
        : null,
      subscriptions: detail.subscriptions.map(serializeSubscription),
      assignments: detail.assignments.map((assignment) =>
        serializeConfig(
          {
            ...assignment.config,
            _count: undefined,
          },
          { includeShareLink: true },
        ),
      ),
      devices: detail.devices.map(serializeDevice),
      counters: detail._count,
    });
  },
  { capability: 'users:read', rate: 'read' },
);

export const PATCH = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const input = updateUserSchema.parse(await readJson(req));
    const updated = await updateUser(params.id, input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return jsonOk(serializeUser(updated));
  },
  { capability: 'users:write', rate: 'write' },
);

export const DELETE = withAuth<{ id: string }>(
  async (_req, { user, params, meta }) => {
    await deleteUser(params.id, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonNoContent();
  },
  { capability: 'users:delete', rate: 'write' },
);

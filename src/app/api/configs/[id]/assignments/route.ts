import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonOk } from '@/lib/api/response';
import { assignConfigSchema } from '@/lib/validation';
import { assignUsers, unassignUser } from '@/server/services/config-service';

/**
 * POST   /api/configs/:id/assignments — assign users (each gets a new credential)
 * DELETE /api/configs/:id/assignments?userId=… — revoke a user's assignment
 */
export const POST = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const input = assignConfigSchema.parse(await readJson(req));

    const created = await assignUsers(params.id, input.userIds, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    }, {
      trafficLimitGb: input.trafficLimitGb,
      expirationDays: input.expirationDays,
    });

    return jsonCreated(
      created.map((assignment) => ({
        id: assignment.id,
        userId: assignment.userId,
        shareLink: assignment.shareLink,
      })),
    );
  },
  { capability: 'configs:write', rate: 'write' },
);

export const DELETE = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const userId = new URL(req.url).searchParams.get('userId');
    if (!userId) {
      return jsonOk({ success: false, message: 'userId query parameter is required.' }, { status: 400 });
    }

    await unassignUser(params.id, userId, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return jsonOk({ success: true });
  },
  { capability: 'configs:write', rate: 'write' },
);

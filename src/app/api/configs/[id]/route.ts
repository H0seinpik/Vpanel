import { readJson, withAuth } from '@/lib/api/handler';
import { jsonNoContent, jsonOk } from '@/lib/api/response';
import { updateConfigSchema } from '@/lib/validation';
import { serializeAssignment, serializeConfig } from '@/server/serializers';
import { deleteConfig, getConfigForActor, updateConfig } from '@/server/services/config-service';

/**
 * GET    /api/configs/:id — configuration detail incl. assignments
 * PATCH  /api/configs/:id — update parameters / status (re-renders links)
 * DELETE /api/configs/:id — delete
 *
 * A regular user reaching these endpoints only ever sees their own assignment;
 * the ownership check lives in `getConfigForActor` and runs on the server.
 */
export const GET = withAuth<{ id: string }>(
  async (_req, { user, params }) => {
    const config = await getConfigForActor(params.id, {
      id: user.id,
      username: user.username,
      role: user.role,
    });

    const isStaff = user.role === 'ADMIN' || user.role === 'OPERATOR';

    return jsonOk({
      config: serializeConfig(config, { includeShareLink: isStaff }),
      assignments: config.assignments.map((assignment) =>
        serializeAssignment(assignment, { includeShareLink: isStaff || assignment.userId === user.id }),
      ),
      // Share links are credential-bearing: never expose another user's.
      shareLink: isStaff
        ? config.shareLink
        : (config.assignments.find((a) => a.userId === user.id)?.shareLink ?? null),
    });
  },
  { anyOf: ['configs:read', 'self:configs'], rate: 'read' },
);

export const PATCH = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const input = updateConfigSchema.parse(await readJson(req));
    const updated = await updateConfig(params.id, input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return jsonOk(serializeConfig(updated, { includeShareLink: true }));
  },
  { capability: 'configs:write', rate: 'write' },
);

export const DELETE = withAuth<{ id: string }>(
  async (_req, { user, params, meta }) => {
    await deleteConfig(params.id, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonNoContent();
  },
  { capability: 'configs:delete', rate: 'write' },
);

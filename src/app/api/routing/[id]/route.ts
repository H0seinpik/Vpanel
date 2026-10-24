import { readJson, withAuth } from '@/lib/api/handler';
import { jsonNoContent, jsonOk } from '@/lib/api/response';
import { updateRoutingRuleSchema } from '@/lib/validation/advanced';
import {
  deleteRoutingRule,
  getRoutingRule,
  updateRoutingRule,
} from '@/server/services/advanced-routing-service';

/** GET / PATCH / DELETE one routing rule. */
export const GET = withAuth<{ id: string }>(
  async (_req, { params }) => jsonOk(await getRoutingRule(params.id)),
  { anyOf: ['configs:read'], rate: 'read' },
);

export const PATCH = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const input = updateRoutingRuleSchema.parse(await readJson(req));
    const updated = await updateRoutingRule(params.id, input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonOk(updated);
  },
  { capability: 'configs:write', rate: 'write' },
);

export const DELETE = withAuth<{ id: string }>(
  async (_req, { user, params, meta }) => {
    await deleteRoutingRule(params.id, {
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

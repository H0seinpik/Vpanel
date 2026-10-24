import { readJson, withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { updatePlanSchema } from '@/lib/validation';
import { serializePlan } from '@/server/serializers';
import { deletePlan, updatePlan } from '@/server/services/plan-service';

/**
 * PATCH  /api/plans/:id — update a plan
 * DELETE /api/plans/:id — delete (or archive when subscriptions exist)
 */
export const PATCH = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const input = updatePlanSchema.parse(await readJson(req));
    const plan = await updatePlan(params.id, input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonOk(serializePlan(plan));
  },
  { capability: 'plans:write', rate: 'write' },
);

export const DELETE = withAuth<{ id: string }>(
  async (_req, { user, params, meta }) => {
    const result = await deletePlan(params.id, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonOk(result);
  },
  { capability: 'plans:write', rate: 'write' },
);

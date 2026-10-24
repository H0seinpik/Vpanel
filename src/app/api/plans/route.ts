import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonOk } from '@/lib/api/response';
import { createPlanSchema } from '@/lib/validation';
import { serializePlan } from '@/server/serializers';
import { createPlan, listPlans } from '@/server/services/plan-service';

/**
 * GET  /api/plans — plan catalog (plans:read)
 * POST /api/plans — create a plan (plans:write)
 */
export const GET = withAuth(
  async (req) => {
    const status = new URL(req.url).searchParams.get('status');
    const plans = await listPlans(
      status === 'ACTIVE' || status === 'ARCHIVED' ? { status } : {},
    );
    return jsonOk(plans.map(serializePlan));
  },
  { capability: 'plans:read', rate: 'read' },
);

export const POST = withAuth(
  async (req, { user, meta }) => {
    const input = createPlanSchema.parse(await readJson(req));
    const plan = await createPlan(input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonCreated(serializePlan(plan));
  },
  { capability: 'plans:write', rate: 'write' },
);

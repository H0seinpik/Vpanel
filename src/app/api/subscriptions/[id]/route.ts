import { readJson, withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { updateSubscription } from '@/server/services/subscription-service';
import { cancelSubscription } from '@/server/services/subscription-service';
import { serializeSubscription } from '@/server/serializers';

/**
 * PATCH  /api/subscriptions/:id — update quota / extend / reset
 * DELETE /api/subscriptions/:id — cancel
 */
export const PATCH = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const body = (await readJson(req)) as Record<string, unknown>;
    const updated = await updateSubscription(
      params.id,
      {
        planId: body.planId as string | null | undefined,
        serverId: body.serverId as string | null | undefined,
        quotaType: body.quotaType as never,
        trafficLimitGb: body.trafficLimitGb as number | null | undefined,
        extendDays: body.extendDays as number | undefined,
        status: body.status as never,
        resetTraffic: body.resetTraffic as boolean | undefined,
      },
      {
        id: user.id,
        username: user.username,
        role: user.role,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    );
    return jsonOk(serializeSubscription(updated));
  },
  { capability: 'subscriptions:write', rate: 'write' },
);

export const DELETE = withAuth<{ id: string }>(
  async (_req, { user, params, meta }) => {
    const cancelled = await cancelSubscription(params.id, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonOk(serializeSubscription(cancelled));
  },
  { capability: 'subscriptions:write', rate: 'write' },
);

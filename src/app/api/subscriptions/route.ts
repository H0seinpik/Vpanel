import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonPaginated, paginate, parsePagination } from '@/lib/api/response';
import { createSubscriptionSchema } from '@/lib/validation';
import { serializeSubscription } from '@/server/serializers';
import { createSubscription, listSubscriptions } from '@/server/services/subscription-service';

/**
 * GET  /api/subscriptions — list (subscriptions:read)
 * POST /api/subscriptions — create (subscriptions:write)
 */
export const GET = withAuth(
  async (req) => {
    const url = new URL(req.url);
    const pagination = parsePagination(url);

    const { items, total } = await listSubscriptions(
      {
        userId: url.searchParams.get('userId') ?? undefined,
        planId: url.searchParams.get('planId') ?? undefined,
        status: (url.searchParams.get('status') as never) ?? undefined,
      },
      pagination,
    );

    return jsonPaginated(
      paginate(items.map(serializeSubscription), total, pagination.page, pagination.pageSize),
    );
  },
  { capability: 'subscriptions:read', rate: 'read' },
);

export const POST = withAuth(
  async (req, { user, meta }) => {
    const input = createSubscriptionSchema.parse(await readJson(req));
    const subscription = await createSubscription(input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonCreated(serializeSubscription(subscription));
  },
  { capability: 'subscriptions:write', rate: 'write' },
);

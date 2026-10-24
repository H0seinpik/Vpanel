import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonPaginated, paginate, parsePagination } from '@/lib/api/response';
import { advancedQuerySchema, createRoutingRuleSchema } from '@/lib/validation/advanced';
import { createRoutingRule, listRoutingRules } from '@/server/services/advanced-routing-service';

/** GET /api/routing — list routing rules. POST /api/routing — create one. */
export const GET = withAuth(
  async (req) => {
    const url = new URL(req.url);
    const query = advancedQuerySchema.parse(Object.fromEntries(url.searchParams));
    const pagination = parsePagination(url);

    const { items, total } = await listRoutingRules(
      {
        search: query.search,
        serverId: query.serverId,
        enabled: query.enabled === undefined ? undefined : query.enabled === 'true',
      },
      pagination,
    );

    return jsonPaginated(paginate(items, total, pagination.page, pagination.pageSize));
  },
  { anyOf: ['configs:read'], rate: 'read' },
);

export const POST = withAuth(
  async (req, { user, meta }) => {
    const input = createRoutingRuleSchema.parse(await readJson(req));
    const rule = await createRoutingRule(input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonCreated(rule);
  },
  { capability: 'configs:write', rate: 'write' },
);

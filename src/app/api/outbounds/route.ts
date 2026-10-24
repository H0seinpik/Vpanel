import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonPaginated, paginate, parsePagination } from '@/lib/api/response';
import { advancedQuerySchema, createOutboundSchema } from '@/lib/validation/advanced';
import { createOutbound, listOutbounds } from '@/server/services/advanced-routing-service';

/** GET /api/outbounds — list raw Xray outbounds. POST /api/outbounds — create one. */
export const GET = withAuth(
  async (req) => {
    const url = new URL(req.url);
    const query = advancedQuerySchema.parse(Object.fromEntries(url.searchParams));
    const pagination = parsePagination(url);

    const { items, total } = await listOutbounds(
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
    const input = createOutboundSchema.parse(await readJson(req));
    const outbound = await createOutbound(input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonCreated(outbound);
  },
  { capability: 'configs:write', rate: 'write' },
);

import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonPaginated, paginate, parsePagination } from '@/lib/api/response';
import { advancedQuerySchema, createInboundSchema } from '@/lib/validation/advanced';
import { createInbound, listInbounds } from '@/server/services/advanced-routing-service';

/**
 * GET  /api/inbounds — list raw Xray inbounds
 * POST /api/inbounds — create one
 *
 * These are the operator-managed inbounds that sit beside the wizard-generated
 * configurations; they are merged into config.json by the supervisor.
 */
export const GET = withAuth(
  async (req) => {
    const url = new URL(req.url);
    const query = advancedQuerySchema.parse(Object.fromEntries(url.searchParams));
    const pagination = parsePagination(url);

    const { items, total } = await listInbounds(
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
    const input = createInboundSchema.parse(await readJson(req));
    const inbound = await createInbound(input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonCreated(inbound);
  },
  { capability: 'configs:write', rate: 'write' },
);

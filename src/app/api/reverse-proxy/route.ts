import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonPaginated, paginate, parsePagination } from '@/lib/api/response';
import { advancedQuerySchema, createReverseProxySchema } from '@/lib/validation/advanced';
import { createReverseProxy, listReverseProxies } from '@/server/services/advanced-routing-service';

/**
 * GET  /api/reverse-proxy — list bridge/portal rows
 * POST /api/reverse-proxy — create one
 *
 * A pair is a PORTAL on the node that needs connectivity (Iran) and a BRIDGE on
 * the node that has it (Foreign); each row carries the peer address in `domain`.
 */
export const GET = withAuth(
  async (req) => {
    const url = new URL(req.url);
    const query = advancedQuerySchema.parse(Object.fromEntries(url.searchParams));
    const pagination = parsePagination(url);

    const { items, total } = await listReverseProxies(
      {
        search: query.search,
        serverId: query.serverId,
        enabled: query.enabled === undefined ? undefined : query.enabled === 'true',
        role: query.role,
      },
      pagination,
    );

    return jsonPaginated(paginate(items, total, pagination.page, pagination.pageSize));
  },
  { anyOf: ['configs:read'], rate: 'read' },
);

export const POST = withAuth(
  async (req, { user, meta }) => {
    const input = createReverseProxySchema.parse(await readJson(req));
    const row = await createReverseProxy(input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonCreated(row);
  },
  { capability: 'configs:write', rate: 'write' },
);

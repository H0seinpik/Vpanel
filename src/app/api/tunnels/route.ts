import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonPaginated, paginate, parsePagination } from '@/lib/api/response';
import { createTunnelSchema, tunnelQuerySchema } from '@/lib/validation';
import { serializeTunnel } from '@/server/serializers';
import { createTunnel, getTunnelCounters, listTunnels } from '@/server/services/tunnel-service';
import { getXrayRuntime } from '@/server/services/xray-service';

/**
 * GET  /api/tunnels — paginated list + counters + node runtime (tunnels:read)
 * POST /api/tunnels — create a port-forwarding tunnel (tunnels:write)
 *
 * `runtime` lets the page distinguish "enabled" from "actually applied": a
 * tunnel saved a moment ago is enabled but may still be waiting for the next
 * reconcile (or for Xray to start).
 */
export const GET = withAuth(
  async (req) => {
    const url = new URL(req.url);
    const query = tunnelQuerySchema.parse(Object.fromEntries(url.searchParams));
    const pagination = parsePagination(url);

    const [{ items, total }, counters, runtime] = await Promise.all([
      listTunnels(query, pagination),
      getTunnelCounters(),
      getXrayRuntime(),
    ]);

    const payload = jsonPaginated(
      paginate(items.map(serializeTunnel), total, pagination.page, pagination.pageSize),
    );
    const body = await payload.json();
    return Response.json({ ...body, counters, runtime });
  },
  { capability: 'tunnels:read', rate: 'read' },
);

export const POST = withAuth(
  async (req, { user, meta }) => {
    const input = createTunnelSchema.parse(await readJson(req));

    const created = await createTunnel(input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return jsonCreated(serializeTunnel(created));
  },
  { capability: 'tunnels:write', rate: 'write' },
);

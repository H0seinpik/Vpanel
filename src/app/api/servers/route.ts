import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonPaginated, paginate, parsePagination } from '@/lib/api/response';
import { createServerSchema, serverQuerySchema } from '@/lib/validation';
import { serializeServer } from '@/server/serializers';
import { createServer, getServerCounters, listServers } from '@/server/services/server-service';

/**
 * GET  /api/servers — paginated list + counters (servers:read)
 * POST /api/servers — register a server (servers:write)
 */
export const GET = withAuth(
  async (req) => {
    const url = new URL(req.url);
    const query = serverQuerySchema.parse(Object.fromEntries(url.searchParams));
    const pagination = parsePagination(url);

    const [{ items, total }, counters] = await Promise.all([
      listServers(query, pagination),
      getServerCounters(),
    ]);

    const payload = jsonPaginated(
      paginate(items.map(serializeServer), total, pagination.page, pagination.pageSize),
    );
    // Counters ride along in the same response to avoid a second round-trip.
    const body = await payload.json();
    return Response.json({ ...body, counters });
  },
  { capability: 'servers:read', rate: 'read' },
);

export const POST = withAuth(
  async (req, { user, meta }) => {
    const input = createServerSchema.parse(await readJson(req));
    const created = await createServer(input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    // Agent credentials are never echoed back.
    return jsonCreated(serializeServer(created));
  },
  { capability: 'servers:write', rate: 'write' },
);

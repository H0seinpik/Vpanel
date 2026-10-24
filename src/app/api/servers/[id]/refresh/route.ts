import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { getServerById, refreshServerStatus } from '@/server/services/server-service';
import { serializeServer } from '@/server/serializers';

/**
 * POST /api/servers/:id/refresh
 *
 * Forces an immediate status/metrics refresh instead of waiting for the next
 * monitoring worker tick.
 */
export const POST = withAuth<{ id: string }>(
  async (_req, { params }) => {
    await refreshServerStatus(params.id);
    const server = await getServerById(params.id);
    return jsonOk(serializeServer(server));
  },
  { capability: 'servers:read', rate: 'sensitive' },
);

import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { trafficQuerySchema } from '@/lib/validation';
import {
  daysAgo,
  getTopUsers,
  getTrafficSeries,
  getTrafficTotals,
} from '@/server/services/traffic-service';

/**
 * GET /api/traffic/servers/:id — usage breakdown for one server.
 */
export const GET = withAuth<{ id: string }>(
  async (req, { params }) => {
    const url = new URL(req.url);
    const query = trafficQuerySchema.parse(Object.fromEntries(url.searchParams));
    const from = query.from ?? daysAgo(30);
    const to = query.to ?? new Date();
    const filter = { serverId: params.id, from, to };

    const [totals, series, byUser] = await Promise.all([
      getTrafficTotals(filter),
      getTrafficSeries(filter, query.granularity),
      getTopUsers(filter, 10),
    ]);

    return jsonOk({ serverId: params.id, totals, series, byUser });
  },
  { capability: 'traffic:read', rate: 'read' },
);

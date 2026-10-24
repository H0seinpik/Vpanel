import { withAuth } from '@/lib/api/handler';
import { jsonPaginated, jsonOk, paginate, parsePagination } from '@/lib/api/response';
import { trafficQuerySchema } from '@/lib/validation';
import { serializeTrafficUsage } from '@/server/serializers';
import {
  daysAgo,
  getTopServers,
  getTopUsers,
  getTrafficSeries,
  getTrafficTotals,
  listTrafficUsage,
} from '@/server/services/traffic-service';

/**
 * GET /api/traffic?userId=&serverId=&configId=&from=&to=&granularity=
 *
 * Returns totals, a time series, leaderboards and a page of raw ledger rows in
 * a single response. Staff-only: users read their own usage from
 * /api/me/dashboard or /api/traffic/users/:id (self).
 */
export const GET = withAuth(
  async (req) => {
    const url = new URL(req.url);
    const query = trafficQuerySchema.parse(Object.fromEntries(url.searchParams));
    const pagination = parsePagination(url, { page: 1, pageSize: 25, maxPageSize: 200 });

    const from = query.from ?? daysAgo(30);
    const to = query.to ?? new Date();
    const filter = {
      userId: query.userId,
      serverId: query.serverId,
      configId: query.configId,
      from,
      to,
    };

    const [totals, series, topUsers, topServers, recent] = await Promise.all([
      getTrafficTotals(filter),
      getTrafficSeries(filter, query.granularity),
      getTopUsers(filter, 8),
      getTopServers(filter, 8),
      listTrafficUsage(filter, pagination),
    ]);

    return jsonOk({
      totals,
      series,
      topUsers,
      topServers,
      recent: recent.items.map(serializeTrafficUsage),
      pagination: paginate([], recent.total, pagination.page, pagination.pageSize).pagination,
    });
  },
  { capability: 'traffic:read', rate: 'read' },
);

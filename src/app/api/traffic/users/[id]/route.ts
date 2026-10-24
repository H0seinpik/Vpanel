import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/api/errors';
import { isStaff } from '@/lib/auth/rbac';
import { trafficQuerySchema } from '@/lib/validation';
import {
  daysAgo,
  getTopServers,
  getTrafficSeries,
  getTrafficTotals,
} from '@/server/services/traffic-service';

/**
 * GET /api/traffic/users/:id
 *
 * A user may read their own usage; staff may read anyone's. The check is done
 * server-side — the URL is never trusted on its own.
 */
export const GET = withAuth<{ id: string }>(
  async (req, { user, params }) => {
    if (!isStaff(user.role) && user.id !== params.id) {
      throw new ForbiddenError('You can only view your own traffic.');
    }

    const url = new URL(req.url);
    const query = trafficQuerySchema.parse(Object.fromEntries(url.searchParams));
    const from = query.from ?? daysAgo(30);
    const to = query.to ?? new Date();
    const filter = { userId: params.id, from, to };

    const [totals, series, byServer] = await Promise.all([
      getTrafficTotals(filter),
      getTrafficSeries(filter, query.granularity),
      getTopServers(filter, 10),
    ]);

    return jsonOk({ userId: params.id, totals, series, byServer });
  },
  { anyOf: ['traffic:read', 'self:traffic'], rate: 'read' },
);

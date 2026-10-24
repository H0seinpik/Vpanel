import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { getUserDashboard } from '@/server/services/dashboard-service';

/**
 * GET /api/me/dashboard
 *
 * The personal dashboard: plan, traffic, expiry, servers, configurations and
 * usage history — for the authenticated user only.
 */
export const GET = withAuth(async (_req, { user }) => {
  const dashboard = await getUserDashboard(user.id);
  return jsonOk(dashboard);
});

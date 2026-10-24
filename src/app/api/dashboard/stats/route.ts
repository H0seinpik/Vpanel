import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { getAdminStats, getRecentActivity } from '@/server/services/dashboard-service';
import { getServerCounters } from '@/server/services/server-service';
import { getUserCounters } from '@/server/services/user-service';
import { serializeAuditLog } from '@/server/serializers';

/**
 * GET /api/dashboard/stats
 *
 * The top-of-dashboard counters plus the most recent audit activity. Polled by
 * the dashboard for periodic refresh (no full page reload).
 */
export const GET = withAuth(
  async () => {
    const [stats, userCounters, serverCounters, activity] = await Promise.all([
      getAdminStats(),
      getUserCounters(),
      getServerCounters(),
      getRecentActivity(8),
    ]);

    return jsonOk({
      stats,
      userCounters,
      serverCounters,
      recentActivity: activity.map(serializeAuditLog),
      generatedAt: new Date().toISOString(),
    });
  },
  { capability: 'monitoring:read', rate: 'read' },
);

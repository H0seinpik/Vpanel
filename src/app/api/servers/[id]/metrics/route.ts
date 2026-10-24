import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { getServerMetrics } from '@/server/services/server-service';

/**
 * GET /api/servers/:id/metrics?limit=60
 *
 * Time-series samples for the monitoring charts. Returned oldest-first so the
 * client can plot directly.
 */
export const GET = withAuth<{ id: string }>(
  async (req, { params }) => {
    const limit = Math.min(500, Math.max(1, Number(new URL(req.url).searchParams.get('limit') ?? 60)));
    const metrics = await getServerMetrics(params.id, limit);

    return jsonOk(
      metrics
        .map((metric) => ({
          id: metric.id,
          cpuPercent: metric.cpuPercent,
          memPercent: metric.memPercent,
          activeConnections: metric.activeConnections,
          activeUsers: metric.activeUsers,
          netInBytes: Number(metric.netInBytes),
          netOutBytes: Number(metric.netOutBytes),
          sampledAt: metric.sampledAt.toISOString(),
        }))
        .reverse(),
    );
  },
  { capability: 'servers:read', rate: 'read' },
);

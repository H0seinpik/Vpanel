import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { getDashboardCharts } from '@/server/services/dashboard-service';

/**
 * GET /api/dashboard/charts?days=30
 *
 * Every chart series the dashboard renders, in one payload.
 */
export const GET = withAuth(
  async (req) => {
    const daysParam = Number(new URL(req.url).searchParams.get('days') ?? 30);
    const days = Number.isFinite(daysParam) ? Math.min(365, Math.max(1, daysParam)) : 30;

    const charts = await getDashboardCharts(days);
    return jsonOk(charts);
  },
  { capability: 'monitoring:read', rate: 'read' },
);

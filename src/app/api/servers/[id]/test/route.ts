import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { testServerConnection } from '@/server/services/server-service';

/**
 * POST /api/servers/:id/test
 *
 * Probes the registered server through the configured node provider. It never
 * contacts any host other than the one stored on this record.
 */
export const POST = withAuth<{ id: string }>(
  async (_req, { user, params, meta }) => {
    const result = await testServerConnection(params.id, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return jsonOk(result);
  },
  { capability: 'servers:write', rate: 'sensitive' },
);

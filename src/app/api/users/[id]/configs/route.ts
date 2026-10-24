import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { serializeConfig } from '@/server/serializers';
import { listConfigsForUser } from '@/server/services/config-service';

/**
 * GET /api/users/:id/configs — every configuration assigned to a user.
 *
 * Staff-only: a regular user reads their own list from /api/me/configs.
 */
export const GET = withAuth<{ id: string }>(
  async (_req, { params }) => {
    const configs = await listConfigsForUser(params.id);
    return jsonOk(configs);
  },
  { capability: 'users:read', rate: 'read' },
);

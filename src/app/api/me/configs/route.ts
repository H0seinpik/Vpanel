import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { listConfigsForUser } from '@/server/services/config-service';

/**
 * GET /api/me/configs
 *
 * Every configuration assigned to the caller, with THEIR OWN share link only.
 */
export const GET = withAuth(async (_req, { user }) => {
  const configs = await listConfigsForUser(user.id);
  return jsonOk(configs);
});

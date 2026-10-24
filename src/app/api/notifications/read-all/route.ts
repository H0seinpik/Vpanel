import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { markAllRead } from '@/server/services/notification-service';

/** POST /api/notifications/read-all — mark every notification as read. */
export const POST = withAuth(async (_req, { user }) => {
  const result = await markAllRead(user.id);
  return jsonOk({ updated: result.count });
});

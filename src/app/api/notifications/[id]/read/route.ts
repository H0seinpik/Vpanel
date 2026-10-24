import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { markNotificationRead } from '@/server/services/notification-service';

/**
 * POST /api/notifications/:id/read
 *
 * Scoped update — a user can only mark their own notifications (or broadcasts)
 * as read; the WHERE clause enforces it in the database.
 */
export const POST = withAuth<{ id: string }>(async (_req, { user, params }) => {
  const result = await markNotificationRead(params.id, user.id);
  return jsonOk({ updated: result.count });
});

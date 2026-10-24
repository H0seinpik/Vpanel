import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { serializeNotification } from '@/server/serializers';
import { listNotifications } from '@/server/services/notification-service';

/**
 * GET /api/notifications?unreadOnly=true&limit=20
 *
 * Returns the caller's notifications plus administrator broadcasts
 * (userId = null). Staff see all broadcasts; users see the ones addressed to
 * them and the general broadcasts.
 */
export const GET = withAuth(async (req, { user }) => {
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));

  const { items, total, unread } = await listNotifications({
    userId: user.id,
    includeBroadcast: true,
    unreadOnly,
    take: limit,
  });

  return jsonOk({
    items: items.map(serializeNotification),
    total,
    unread,
  });
});

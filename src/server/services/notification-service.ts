import type { NotificationSeverity, NotificationType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Notification system.
 *
 * Notifications are stored in the database and surfaced on both the admin and
 * user dashboards. Delivery channels (email / Telegram / webhook) are stubbed
 * behind `dispatchExternal` — the architecture is in place, and enabling a
 * channel is a matter of filling in one function.
 */

export interface CreateNotificationInput {
  userId?: string | null;
  type: NotificationType;
  severity?: NotificationSeverity;
  title: string;
  message: string;
  /** Idempotency key — the same alert is never raised twice. */
  dedupeKey?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createNotification(input: CreateNotificationInput) {
  const data = {
    userId: input.userId ?? null,
    type: input.type,
    severity: input.severity ?? 'INFO',
    title: input.title,
    message: input.message,
    dedupeKey: input.dedupeKey ?? null,
    metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
  };

  if (data.dedupeKey) {
    // Idempotent: an existing alert with the same key wins, nothing is updated.
    return prisma.notification.upsert({
      where: { dedupeKey: data.dedupeKey },
      create: data,
      update: {},
    });
  }

  return prisma.notification.create({ data });
}

export async function listNotifications(options: {
  userId?: string | null;
  /** When true, include admin-broadcast notifications (userId = null). */
  includeBroadcast?: boolean;
  unreadOnly?: boolean;
  skip?: number;
  take?: number;
}) {
  const where: Prisma.NotificationWhereInput = {};

  if (options.userId !== undefined) {
    where.OR = options.includeBroadcast
      ? [{ userId: options.userId }, { userId: null }]
      : [{ userId: options.userId }];
  }
  if (options.unreadOnly) where.isRead = false;

  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: options.skip ?? 0,
      take: options.take ?? 20,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, isRead: false } }),
  ]);

  return { items, total, unread };
}

export async function unreadCount(userId: string | null): Promise<number> {
  return prisma.notification.count({
    where: userId ? { OR: [{ userId }, { userId: null }], isRead: false } : { isRead: false },
  });
}

export async function markNotificationRead(id: string, userId: string) {
  // Scoped update: a user can only mark their own (or broadcast) notifications.
  return prisma.notification.updateMany({
    where: { id, OR: [{ userId }, { userId: null }] },
    data: { isRead: true, readAt: new Date() },
  });
}

export async function markAllRead(userId: string) {
  return prisma.notification.updateMany({
    where: { OR: [{ userId }, { userId: null }], isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
}

export async function deleteNotification(id: string, userId: string) {
  return prisma.notification.deleteMany({ where: { id, userId } });
}

/**
 * External delivery hook. Email/Telegram/webhook integrations plug in here.
 * Returns silently when no channel is configured so it is always safe to call.
 */
export async function dispatchExternal(_notification: CreateNotificationInput): Promise<void> {
  // Intentionally a no-op by default. Implementations should read their
  // credentials from the environment (SMTP_URL / TELEGRAM_BOT_TOKEN / webhook
  // URL from settings) and must never throw into the caller.
  return;
}

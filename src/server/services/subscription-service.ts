import { Prisma, SubscriptionStatus, QuotaType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';
import { gbToBytes } from '@/lib/format';
import type { ActorContext } from './user-service';

/**
 * Subscriptions bind a user to a plan (optionally scoped to one server) and
 * carry the authoritative quota + validity window for that user.
 */

export async function listSubscriptions(
  query: { userId?: string; status?: SubscriptionStatus; planId?: string },
  pagination: { skip: number; take: number },
) {
  const where: Prisma.SubscriptionWhereInput = {};
  if (query.userId) where.userId = query.userId;
  if (query.status) where.status = query.status;
  if (query.planId) where.planId = query.planId;

  const [items, total] = await Promise.all([
    prisma.subscription.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.take,
      include: {
        plan: { select: { id: true, name: true } },
        server: { select: { id: true, name: true } },
        user: { select: { id: true, username: true, displayName: true } },
      },
    }),
    prisma.subscription.count({ where }),
  ]);

  return { items, total };
}

export async function getSubscriptionById(id: string) {
  const subscription = await prisma.subscription.findUnique({
    where: { id },
    include: {
      plan: true,
      server: { select: { id: true, name: true, hostname: true } },
      user: { select: { id: true, username: true, displayName: true, email: true } },
    },
  });
  if (!subscription) throw new NotFoundError('Subscription');
  return subscription;
}

export interface CreateSubscriptionInput {
  userId: string;
  planId?: string | null;
  serverId?: string | null;
  quotaType?: QuotaType;
  trafficLimitGb?: number | null;
  durationDays?: number | null;
}

export async function createSubscription(input: CreateSubscriptionInput, actor: ActorContext) {
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new NotFoundError('User');

  const plan = input.planId ? await prisma.plan.findUnique({ where: { id: input.planId } }) : null;

  // Plan values are copied onto the subscription so later plan edits do not
  // retroactively change an existing customer's terms.
  const limitGb =
    input.trafficLimitGb !== undefined
      ? input.trafficLimitGb
      : plan
        ? plan.trafficLimitBytes === null
          ? null
          : Number(plan.trafficLimitBytes) / 1024 ** 3
        : null;

  const durationDays = input.durationDays ?? plan?.durationDays ?? 30;

  if (input.serverId) {
    const server = await prisma.server.findUnique({ where: { id: input.serverId } });
    if (!server) throw new ValidationError('The selected server does not exist.');
  }

  const startsAt = new Date();
  const endsAt = durationDays ? new Date(startsAt.getTime() + durationDays * 86_400_000) : null;

  const quotaType = input.quotaType ?? (limitGb === null ? QuotaType.UNLIMITED : QuotaType.TOTAL);

  const subscription = await prisma.$transaction(async (tx) => {
    const created = await tx.subscription.create({
      data: {
        userId: input.userId,
        planId: plan?.id ?? null,
        serverId: input.serverId ?? null,
        quotaType,
        trafficLimitBytes: limitGb === null ? null : gbToBytes(limitGb),
        startsAt,
        endsAt,
        resetAt: quotaType === QuotaType.MONTHLY ? new Date(startsAt.getTime() + 30 * 86_400_000) : null,
        status: SubscriptionStatus.ACTIVE,
      },
    });

    // Keep the user record in step with its newest subscription.
    await tx.user.update({
      where: { id: input.userId },
      data: {
        planId: plan?.id ?? null,
        trafficLimitBytes: limitGb === null ? null : gbToBytes(limitGb),
        expirationDate: endsAt,
      },
    });

    return created;
  });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.SUBSCRIPTION_CREATE,
    targetType: 'subscription',
    targetId: subscription.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { userId: input.userId, planId: plan?.id ?? null, durationDays },
  });

  return subscription;
}

export interface UpdateSubscriptionInput {
  planId?: string | null;
  serverId?: string | null;
  quotaType?: QuotaType;
  trafficLimitGb?: number | null;
  extendDays?: number;
  status?: SubscriptionStatus;
  resetTraffic?: boolean;
}

export async function updateSubscription(
  id: string,
  input: UpdateSubscriptionInput,
  actor: ActorContext,
) {
  const current = await prisma.subscription.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Subscription');

  const data: Prisma.SubscriptionUpdateInput = {};

  if (input.planId !== undefined) {
    data.plan = input.planId ? { connect: { id: input.planId } } : { disconnect: true };
  }
  if (input.serverId !== undefined) {
    data.server = input.serverId ? { connect: { id: input.serverId } } : { disconnect: true };
  }
  if (input.quotaType !== undefined) data.quotaType = input.quotaType;
  if (input.status !== undefined) data.status = input.status;
  if (input.trafficLimitGb !== undefined) {
    data.trafficLimitBytes = input.trafficLimitGb === null ? null : gbToBytes(input.trafficLimitGb);
  }
  if (input.resetTraffic) data.trafficUsedBytes = 0n;
  if (input.extendDays) {
    const base = current.endsAt && current.endsAt > new Date() ? current.endsAt : new Date();
    data.endsAt = new Date(base.getTime() + input.extendDays * 86_400_000);
  }

  const updated = await prisma.subscription.update({ where: { id }, data });

  // Mirror the changes onto the user so both stay consistent.
  if (input.trafficLimitGb !== undefined || input.resetTraffic || input.extendDays || input.status) {
    await prisma.user.update({
      where: { id: current.userId },
      data: {
        ...(input.trafficLimitGb !== undefined
          ? { trafficLimitBytes: input.trafficLimitGb === null ? null : gbToBytes(input.trafficLimitGb) }
          : {}),
        ...(input.resetTraffic ? { trafficUsedBytes: 0n } : {}),
        ...(updated.endsAt ? { expirationDate: updated.endsAt } : {}),
        ...(input.status === SubscriptionStatus.ACTIVE ? { status: 'ACTIVE' } : {}),
      },
    });
  }

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.SUBSCRIPTION_UPDATE,
    targetType: 'subscription',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { fields: Object.keys(input) },
  });

  return updated;
}

export async function cancelSubscription(id: string, actor: ActorContext) {
  const current = await prisma.subscription.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Subscription');

  const updated = await prisma.subscription.update({
    where: { id },
    data: { status: SubscriptionStatus.CANCELLED },
  });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.SUBSCRIPTION_UPDATE,
    targetType: 'subscription',
    targetId: id,
    metadata: { cancelled: true },
  });

  return updated;
}

export async function listSubscriptionsForUser(userId: string) {
  return prisma.subscription.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      plan: { select: { id: true, name: true, deviceLimit: true } },
      server: { select: { id: true, name: true, location: true } },
    },
  });
}

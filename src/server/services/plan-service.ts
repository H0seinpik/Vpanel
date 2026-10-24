import { PlanStatus, Prisma, ProtocolType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';
import { gbToBytes } from '@/lib/format';
import type { ActorContext } from './user-service';

/**
 * Plan catalog.
 *
 * Plans are reusable templates (traffic allowance + duration + device limit +
 * allowed protocols/servers). Assigning a plan to a user or creating a
 * subscription copies the plan's values, so editing a plan later never
 * silently changes an existing subscription.
 */

export async function listPlans(options: { status?: PlanStatus } = {}) {
  return prisma.plan.findMany({
    where: options.status ? { status: options.status } : undefined,
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    include: { _count: { select: { subscriptions: true } } },
  });
}

export async function getPlanById(id: string) {
  const plan = await prisma.plan.findUnique({
    where: { id },
    include: { _count: { select: { subscriptions: true } } },
  });
  if (!plan) throw new NotFoundError('Plan');
  return plan;
}

export interface CreatePlanInput {
  name: string;
  description?: string;
  priceCents?: number;
  currency?: string;
  trafficLimitGb?: number | null;
  durationDays?: number;
  deviceLimit?: number;
  allowedProtocols?: ProtocolType[];
  allowedServerIds?: string[];
  status?: PlanStatus;
  isDefault?: boolean;
}

export async function createPlan(input: CreatePlanInput, actor: ActorContext) {
  const duplicate = await prisma.plan.findUnique({ where: { name: input.name } });
  if (duplicate) throw new ConflictError('A plan with that name already exists.');

  const plan = await prisma.$transaction(async (tx) => {
    // Only one plan may be the default.
    if (input.isDefault) {
      await tx.plan.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    return tx.plan.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        priceCents: input.priceCents ?? 0,
        currency: input.currency ?? 'USD',
        trafficLimitBytes:
          input.trafficLimitGb === undefined || input.trafficLimitGb === null
            ? null
            : gbToBytes(input.trafficLimitGb),
        durationDays: input.durationDays ?? 30,
        deviceLimit: input.deviceLimit ?? 1,
        allowedProtocols: input.allowedProtocols ?? [
          ProtocolType.VLESS,
          ProtocolType.VMESS,
          ProtocolType.TROJAN,
          ProtocolType.SHADOWSOCKS,
        ],
        allowedServerIds: input.allowedServerIds ?? [],
        status: input.status ?? PlanStatus.ACTIVE,
        isDefault: input.isDefault ?? false,
        createdById: actor.id,
      },
    });
  });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.PLAN_CREATE,
    targetType: 'plan',
    targetId: plan.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { name: plan.name, durationDays: plan.durationDays },
  });

  return plan;
}

export async function updatePlan(id: string, input: Partial<CreatePlanInput>, actor: ActorContext) {
  const current = await prisma.plan.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Plan');

  const data: Prisma.PlanUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.priceCents !== undefined) data.priceCents = input.priceCents;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.trafficLimitGb !== undefined) {
    data.trafficLimitBytes = input.trafficLimitGb === null ? null : gbToBytes(input.trafficLimitGb);
  }
  if (input.durationDays !== undefined) data.durationDays = input.durationDays;
  if (input.deviceLimit !== undefined) data.deviceLimit = input.deviceLimit;
  if (input.allowedProtocols !== undefined) data.allowedProtocols = input.allowedProtocols;
  if (input.allowedServerIds !== undefined) data.allowedServerIds = input.allowedServerIds;
  if (input.status !== undefined) data.status = input.status;

  const plan = await prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.plan.updateMany({ where: { isDefault: true, NOT: { id } }, data: { isDefault: false } });
      data.isDefault = true;
    }
    return tx.plan.update({ where: { id }, data });
  });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.PLAN_UPDATE,
    targetType: 'plan',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { fields: Object.keys(input) },
  });

  return plan;
}

/**
 * Deleting a plan with live subscriptions would orphan them, so such plans are
 * archived instead. Plans with no subscriptions are deleted outright.
 */
export async function deletePlan(id: string, actor: ActorContext) {
  const plan = await prisma.plan.findUnique({
    where: { id },
    include: { _count: { select: { subscriptions: true } } },
  });
  if (!plan) throw new NotFoundError('Plan');

  if (plan._count.subscriptions > 0) {
    const archived = await prisma.plan.update({
      where: { id },
      data: { status: PlanStatus.ARCHIVED },
    });
    await recordAudit({
      actorId: actor.id,
      actorName: actor.username,
      action: AUDIT_ACTIONS.PLAN_UPDATE,
      targetType: 'plan',
      targetId: id,
      metadata: { archived: true, reason: 'has active subscriptions' },
    });
    return { id, archived: true, plan: archived };
  }

  await prisma.plan.delete({ where: { id } });
  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.PLAN_DELETE,
    targetType: 'plan',
    targetId: id,
    metadata: { name: plan.name },
  });
  return { id, archived: false };
}

export async function getDefaultPlan() {
  return prisma.plan.findFirst({ where: { isDefault: true, status: PlanStatus.ACTIVE } });
}

/** Guard used when assigning a plan to ensure protocol/server restrictions hold. */
export function assertPlanAllows(
  plan: { allowedProtocols: ProtocolType[]; allowedServerIds: string[] },
  protocol: ProtocolType,
  serverId: string,
) {
  if (plan.allowedProtocols.length && !plan.allowedProtocols.includes(protocol)) {
    throw new ValidationError(`This plan does not permit the ${protocol} protocol.`);
  }
  if (plan.allowedServerIds.length && !plan.allowedServerIds.includes(serverId)) {
    throw new ValidationError('This plan does not permit the selected server.');
  }
}

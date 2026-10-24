import { Prisma, UserRole, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password';
import { revokeAllSessions } from '@/lib/auth/session';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';
import { gbToBytes } from '@/lib/format';
import { getSettings } from './settings-service';
import { createNotification } from './notification-service';

/**
 * User management.
 *
 * Authorisation rules enforced here (not only in the route layer):
 *  - Only an ADMIN may create, edit, or delete an ADMIN account.
 *  - An administrator cannot delete or demote their own last-admin privileges.
 *  - Passwords are validated and hashed; the plaintext never leaves this module.
 */

export interface ActorContext {
  id: string;
  username: string;
  role: UserRole;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ListUsersQuery {
  search?: string;
  status?: UserStatus;
  role?: UserRole;
  serverId?: string;
  sort?: 'createdAt' | 'username' | 'trafficUsedBytes' | 'expirationDate';
  order?: 'asc' | 'desc';
}

export async function listUsers(
  query: ListUsersQuery,
  pagination: { skip: number; take: number },
) {
  const where: Prisma.UserWhereInput = {};

  if (query.search) {
    where.OR = [
      { username: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
      { displayName: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  if (query.status) where.status = query.status;
  if (query.role) where.role = query.role;
  if (query.serverId) {
    where.assignments = { some: { config: { serverId: query.serverId } } };
  }

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { [query.sort ?? 'createdAt']: query.order ?? 'desc' },
      skip: pagination.skip,
      take: pagination.take,
      include: {
        _count: { select: { assignments: true, devices: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return { items, total };
}

export async function getUserById(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');
  return user;
}

/** Full detail payload for the user page: configs, devices, subscription, usage. */
export async function getUserDetail(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      plan: true,
      subscriptions: { orderBy: { createdAt: 'desc' }, take: 5, include: { plan: true, server: true } },
      assignments: {
        include: {
          config: {
            include: {
              server: { select: { id: true, name: true, hostname: true, location: true, status: true } },
            },
          },
        },
      },
      devices: { orderBy: { createdAt: 'desc' } },
      _count: { select: { assignments: true, devices: true, sessions: true } },
    },
  });

  if (!user) throw new NotFoundError('User');

  return user;
}

export interface CreateUserInput {
  username: string;
  displayName?: string;
  email: string;
  password: string;
  role?: UserRole;
  status?: UserStatus;
  notes?: string;
  planId?: string | null;
  trafficLimitGb?: number | null;
  expirationDate?: Date | null;
  expirationDays?: number | null;
}

export async function createUser(input: CreateUserInput, actor: ActorContext) {
  // --- Authorization: only admins may mint privileged accounts --------------
  const requestedRole = input.role ?? UserRole.USER;
  if (requestedRole !== UserRole.USER && actor.role !== UserRole.ADMIN) {
    throw new ForbiddenError('Only administrators can create ADMIN or OPERATOR accounts.');
  }

  // --- Validation -----------------------------------------------------------
  const strength = validatePasswordStrength(input.password);
  if (!strength.ok) throw new ValidationError(strength.message ?? 'Weak password');

  const existing = await prisma.user.findFirst({
    where: { OR: [{ username: input.username }, { email: input.email }] },
    select: { username: true, email: true },
  });
  if (existing) {
    throw new ConflictError(
      existing.username === input.username
        ? 'That username is already taken.'
        : 'That email address is already registered.',
    );
  }

  const settings = await getSettings();

  // Resolve limits: explicit value → plan value → system default.
  let plan = null;
  if (input.planId) {
    plan = await prisma.plan.findUnique({ where: { id: input.planId } });
    if (!plan) throw new NotFoundError('Plan');
  }

  const limitGb =
    input.trafficLimitGb !== undefined
      ? input.trafficLimitGb
      : plan
        ? plan.trafficLimitBytes !== null
          ? Number(plan.trafficLimitBytes) / 1024 ** 3
          : null
        : settings.general.defaultTrafficLimitGb;

  const expirationDate =
    input.expirationDate ??
    (input.expirationDays
      ? new Date(Date.now() + input.expirationDays * 86_400_000)
      : plan
        ? new Date(Date.now() + plan.durationDays * 86_400_000)
        : new Date(Date.now() + settings.general.defaultExpirationDays * 86_400_000));

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      username: input.username,
      displayName: input.displayName ?? input.username,
      email: input.email,
      passwordHash,
      role: requestedRole,
      status: input.status ?? UserStatus.ACTIVE,
      notes: input.notes ?? null,
      planId: plan?.id ?? null,
      trafficLimitBytes: limitGb === null ? null : gbToBytes(limitGb),
      expirationDate,
      createdById: actor.id,
    },
  });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.USER_CREATE,
    targetType: 'user',
    targetId: user.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { username: user.username, role: user.role, planId: plan?.id ?? null },
  });

  return user;
}

export interface UpdateUserInput {
  displayName?: string | null;
  email?: string;
  role?: UserRole;
  status?: UserStatus;
  notes?: string | null;
  planId?: string | null;
  trafficLimitGb?: number | null;
  expirationDate?: Date | null;
  extendDays?: number;
  resetTraffic?: boolean;
}

export async function updateUser(id: string, input: UpdateUserInput, actor: ActorContext) {
  const current = await prisma.user.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('User');

  // --- Authorization --------------------------------------------------------
  const touchesPrivilege = input.role !== undefined || current.role === UserRole.ADMIN;
  if (touchesPrivilege && actor.role !== UserRole.ADMIN) {
    throw new ForbiddenError('Only administrators can modify administrator accounts or roles.');
  }
  if (input.role === UserRole.ADMIN && actor.role !== UserRole.ADMIN) {
    throw new ForbiddenError('Only administrators can grant the ADMIN role.');
  }

  // Never allow demoting the last remaining admin.
  if (current.role === UserRole.ADMIN && input.role && input.role !== UserRole.ADMIN) {
    const adminCount = await prisma.user.count({ where: { role: UserRole.ADMIN } });
    if (adminCount <= 1) throw new ValidationError('Cannot demote the last administrator account.');
  }

  if (input.email && input.email !== current.email) {
    const taken = await prisma.user.findUnique({ where: { email: input.email } });
    if (taken) throw new ConflictError('That email address is already registered.');
  }

  // --- Build the update -----------------------------------------------------
  const data: Prisma.UserUpdateInput = {};

  if (input.displayName !== undefined) data.displayName = input.displayName;
  if (input.email !== undefined) data.email = input.email;
  if (input.role !== undefined) data.role = input.role;
  if (input.status !== undefined) data.status = input.status;
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.planId !== undefined) {
    data.plan = input.planId ? { connect: { id: input.planId } } : { disconnect: true };
  }

  if (input.trafficLimitGb !== undefined) {
    data.trafficLimitBytes = input.trafficLimitGb === null ? null : gbToBytes(input.trafficLimitGb);
  }

  if (input.expirationDate !== undefined) {
    data.expirationDate = input.expirationDate;
  } else if (input.extendDays) {
    const base = current.expirationDate && current.expirationDate > new Date()
      ? current.expirationDate
      : new Date();
    data.expirationDate = new Date(base.getTime() + input.extendDays * 86_400_000);
  }

  if (input.resetTraffic) {
    data.trafficUsedBytes = 0n;
  }

  const updated = await prisma.user.update({ where: { id }, data });

  // --- Side effects ---------------------------------------------------------
  if (input.resetTraffic) {
    await prisma.configAssignment.updateMany({ where: { userId: id }, data: { trafficUsedBytes: 0n } });
    await prisma.subscription.updateMany({ where: { userId: id }, data: { trafficUsedBytes: 0n } });
  }

  // Disabling or suspending an account must kill its live sessions immediately.
  if (input.status && (input.status === UserStatus.DISABLED || input.status === UserStatus.SUSPENDED)) {
    await revokeAllSessions(id);
    await createNotification({
      userId: id,
      type: 'USER_SUSPENDED',
      severity: 'CRITICAL',
      title: 'Account access suspended',
      message: 'Your account has been suspended by an administrator.',
      dedupeKey: `user:${id}:suspended:${Date.now()}`,
    });
  }

  // Granular audit entries for the two most sensitive changes.
  if (input.trafficLimitGb !== undefined) {
    await recordAudit({
      actorId: actor.id,
      actorName: actor.username,
      action: AUDIT_ACTIONS.USER_TRAFFIC_LIMIT_CHANGE,
      targetType: 'user',
      targetId: id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { from: String(current.trafficLimitBytes), to: String(updated.trafficLimitBytes) },
    });
  }
  if (input.expirationDate !== undefined || input.extendDays) {
    await recordAudit({
      actorId: actor.id,
      actorName: actor.username,
      action: AUDIT_ACTIONS.USER_EXPIRATION_CHANGE,
      targetType: 'user',
      targetId: id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        from: current.expirationDate?.toISOString() ?? null,
        to: updated.expirationDate?.toISOString() ?? null,
      },
    });
  }
  if (input.status !== undefined && input.status !== current.status) {
    await recordAudit({
      actorId: actor.id,
      actorName: actor.username,
      action: AUDIT_ACTIONS.USER_STATUS_CHANGE,
      targetType: 'user',
      targetId: id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { from: current.status, to: input.status },
    });
  }

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.USER_UPDATE,
    targetType: 'user',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { fields: Object.keys(input) },
  });

  return updated;
}

export async function deleteUser(id: string, actor: ActorContext) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');

  if (actor.id === id) throw new ValidationError('You cannot delete your own account.');
  if (user.role === UserRole.ADMIN) {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenError('Only administrators can delete administrator accounts.');
    }
    const adminCount = await prisma.user.count({ where: { role: UserRole.ADMIN } });
    if (adminCount <= 1) throw new ValidationError('Cannot delete the last administrator account.');
  }

  await prisma.user.delete({ where: { id } });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.USER_DELETE,
    targetType: 'user',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { username: user.username, email: user.email },
  });

  return { id };
}

export async function resetPassword(
  id: string,
  input: { newPassword: string; revokeSessions?: boolean },
  actor: ActorContext,
) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');

  if (user.role === UserRole.ADMIN && actor.role !== UserRole.ADMIN && actor.id !== id) {
    throw new ForbiddenError('Only administrators can reset an administrator password.');
  }

  const strength = validatePasswordStrength(input.newPassword);
  if (!strength.ok) throw new ValidationError(strength.message ?? 'Weak password');

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({ where: { id }, data: { passwordHash } });

  if (input.revokeSessions !== false) {
    await revokeAllSessions(id);
  }

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.PASSWORD_RESET,
    targetType: 'user',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { sessionsRevoked: input.revokeSessions !== false },
  });

  return { id };
}

/** Aggregate counters for the users list header. */
export async function getUserCounters() {
  const [total, active, expired, exceeded, disabled] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: UserStatus.ACTIVE } }),
    prisma.user.count({ where: { status: UserStatus.EXPIRED } }),
    prisma.user.count({ where: { status: UserStatus.TRAFFIC_EXCEEDED } }),
    prisma.user.count({ where: { status: UserStatus.DISABLED } }),
  ]);
  return { total, active, expired, exceeded, disabled };
}

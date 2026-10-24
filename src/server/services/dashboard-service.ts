import { ConfigStatus, Prisma, ServerStatus, UserRole, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isStaff } from '@/lib/auth/rbac';
import { percentOf } from '@/lib/utils';
import { daysAgo, getTopServers, getTopUsers, getTrafficSeries, startOfMonth } from './traffic-service';
import type { ActorContext } from './user-service';

/**
 * Dashboard aggregation.
 *
 * All statistics are computed on the server from the database — never from
 * client-side counters. Expensive aggregates use raw SQL with the indexes
 * declared in the Prisma schema.
 */

export interface AdminStats {
  totalUsers: number;
  activeUsers: number;
  expiredUsers: number;
  trafficExceededUsers: number;
  disabledUsers: number;
  totalServers: number;
  onlineServers: number;
  offlineServers: number;
  warningServers: number;
  totalConfigs: number;
  activeConfigs: number;
  totalTrafficUsedBytes: number;
  totalTrafficRemainingBytes: number;
  unlimitedUsers: number;
  totalPlans: number;
  activeSubscriptions: number;
}

export async function getAdminStats(): Promise<AdminStats> {
  const [
    totalUsers,
    activeUsers,
    expiredUsers,
    trafficExceededUsers,
    disabledUsers,
    totalServers,
    onlineServers,
    offlineServers,
    warningServers,
    totalConfigs,
    activeConfigs,
    totalPlans,
    activeSubscriptions,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: UserStatus.ACTIVE } }),
    prisma.user.count({ where: { status: UserStatus.EXPIRED } }),
    prisma.user.count({ where: { status: UserStatus.TRAFFIC_EXCEEDED } }),
    prisma.user.count({ where: { status: UserStatus.DISABLED } }),
    prisma.server.count(),
    prisma.server.count({ where: { status: ServerStatus.ONLINE } }),
    prisma.server.count({ where: { status: ServerStatus.OFFLINE } }),
    prisma.server.count({ where: { status: ServerStatus.WARNING } }),
    prisma.configuration.count(),
    prisma.configuration.count({ where: { status: ConfigStatus.ACTIVE } }),
    prisma.plan.count(),
    prisma.subscription.count({ where: { status: 'ACTIVE' } }),
  ]);

  // Traffic totals + remaining allowance computed in one pass over `users`.
  const trafficRows = await prisma.$queryRaw<
    Array<{ used: bigint; remaining: bigint; unlimited: bigint }>
  >(Prisma.sql`
    SELECT COALESCE(SUM("trafficUsedBytes"), 0)::bigint AS used,
           COALESCE(SUM(
             CASE WHEN "trafficLimitBytes" IS NOT NULL
                  THEN GREATEST("trafficLimitBytes" - "trafficUsedBytes", 0)
                  ELSE 0 END
           ), 0)::bigint AS remaining,
           COUNT(*) FILTER (WHERE "trafficLimitBytes" IS NULL)::bigint AS unlimited
    FROM "users"
  `);

  const traffic = trafficRows[0];

  return {
    totalUsers,
    activeUsers,
    expiredUsers,
    trafficExceededUsers,
    disabledUsers,
    totalServers,
    onlineServers,
    offlineServers,
    warningServers,
    totalConfigs,
    activeConfigs,
    totalTrafficUsedBytes: Number(traffic?.used ?? 0n),
    totalTrafficRemainingBytes: Number(traffic?.remaining ?? 0n),
    unlimitedUsers: Number(traffic?.unlimited ?? 0n),
    totalPlans,
    activeSubscriptions,
  };
}

export interface DashboardCharts {
  rangeDays: number;
  trafficOverTime: Array<{ bucket: string; uploadBytes: number; downloadBytes: number; totalBytes: number }>;
  activeUsersOverTime: Array<{ bucket: string; count: number }>;
  trafficByServer: Array<{ id: string; label: string; totalBytes: number }>;
  trafficByUser: Array<{ id: string; label: string; totalBytes: number }>;
  configStatus: Array<{ status: string; count: number }>;
  serverStatus: Array<{ status: string; count: number }>;
  trafficTotals: { uploadBytes: number; downloadBytes: number; totalBytes: number };
}

/** Distinct users that moved traffic in each bucket — a real "active" signal. */
async function getActiveUsersSeries(from: Date, to: Date) {
  const rows = await prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
    SELECT date_trunc('day', "timestamp") AS bucket,
           COUNT(DISTINCT "userId")::bigint AS count
    FROM "traffic_usage"
    WHERE "timestamp" >= ${from} AND "timestamp" <= ${to} AND "userId" IS NOT NULL
    GROUP BY bucket
    ORDER BY bucket ASC
  `);
  return rows.map((row) => ({
    bucket: new Date(row.bucket).toISOString(),
    count: Number(row.count),
  }));
}

export async function getDashboardCharts(rangeDays = 30): Promise<DashboardCharts> {
  const to = new Date();
  const from = daysAgo(rangeDays, to);

  const [trafficOverTime, activeUsersOverTime, trafficByServer, trafficByUser, configGroups, serverGroups, totals] =
    await Promise.all([
      getTrafficSeries({ from, to }, 'day'),
      getActiveUsersSeries(from, to),
      getTopServers({ from, to }, 8),
      getTopUsers({ from, to }, 8),
      prisma.configuration.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.server.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.trafficUsage.aggregate({
        where: { timestamp: { gte: from, lte: to } },
        _sum: { uploadBytes: true, downloadBytes: true, totalBytes: true },
      }),
    ]);

  return {
    rangeDays,
    trafficOverTime,
    activeUsersOverTime,
    trafficByServer: trafficByServer.map((s) => ({
      id: s.id,
      label: s.label,
      totalBytes: s.totalBytes,
    })),
    trafficByUser: trafficByUser.map((u) => ({ id: u.id, label: u.label, totalBytes: u.totalBytes })),
    configStatus: configGroups.map((group) => ({ status: group.status, count: group._count._all })),
    serverStatus: serverGroups.map((group) => ({ status: group.status, count: group._count._all })),
    trafficTotals: {
      uploadBytes: Number(totals._sum.uploadBytes ?? 0n),
      downloadBytes: Number(totals._sum.downloadBytes ?? 0n),
      totalBytes: Number(totals._sum.totalBytes ?? 0n),
    },
  };
}

export async function getRecentActivity(limit = 8) {
  return prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { actor: { select: { id: true, username: true, displayName: true } } },
  });
}

// -----------------------------------------------------------------------------
// User dashboard
// -----------------------------------------------------------------------------

export interface UserDashboard {
  user: {
    id: string;
    username: string;
    displayName: string | null;
    email: string;
    status: UserStatus;
    role: UserRole;
    expirationDate: string | null;
    daysRemaining: number | null;
  };
  plan: { id: string; name: string; durationDays: number; deviceLimit: number } | null;
  traffic: {
    usedBytes: number;
    limitBytes: number | null;
    remainingBytes: number | null;
    percent: number;
    unlimited: boolean;
    uploadBytes: number;
    downloadBytes: number;
  };
  servers: Array<{ id: string; name: string; location: string | null; status: string }>;
  configurations: Array<{
    assignmentId: string;
    configId: string;
    name: string;
    protocol: string;
    status: string;
    serverName: string;
    serverLocation: string | null;
    shareLink: string | null;
    trafficUsedBytes: number;
  }>;
  usageOverTime: Array<{ bucket: string; totalBytes: number }>;
  devices: Array<{ id: string; name: string; platform: string; status: string; lastSeenAt: string | null }>;
}

/** Personal dashboard payload. Users only ever see their own data. */
export async function getUserDashboard(userId: string): Promise<UserDashboard> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      plan: true,
      assignments: {
        include: {
          config: {
            include: {
              server: { select: { id: true, name: true, location: true, status: true } },
            },
          },
        },
      },
      devices: { orderBy: { lastSeenAt: 'desc' }, take: 10 },
    },
  });

  if (!user) throw new Error('User not found');

  const monthStart = startOfMonth();
  const [usageSeries, monthUsage] = await Promise.all([
    getTrafficSeries({ userId, from: daysAgo(30) }, 'day'),
    prisma.trafficUsage.aggregate({
      where: { userId, timestamp: { gte: monthStart } },
      _sum: { uploadBytes: true, downloadBytes: true },
    }),
  ]);

  const used = Number(user.trafficUsedBytes);
  const limit = user.trafficLimitBytes === null ? null : Number(user.trafficLimitBytes);

  const serverMap = new Map<string, { id: string; name: string; location: string | null; status: string }>();
  for (const assignment of user.assignments) {
    const server = assignment.config.server;
    if (server) serverMap.set(server.id, server);
  }

  const daysRemaining = user.expirationDate
    ? Math.ceil((user.expirationDate.getTime() - Date.now()) / 86_400_000)
    : null;

  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      status: user.status,
      role: user.role,
      expirationDate: user.expirationDate?.toISOString() ?? null,
      daysRemaining,
    },
    plan: user.plan
      ? {
          id: user.plan.id,
          name: user.plan.name,
          durationDays: user.plan.durationDays,
          deviceLimit: user.plan.deviceLimit,
        }
      : null,
    traffic: {
      usedBytes: used,
      limitBytes: limit,
      remainingBytes: limit === null ? null : Math.max(0, limit - used),
      percent: percentOf(used, limit),
      unlimited: limit === null,
      uploadBytes: Number(monthUsage._sum.uploadBytes ?? 0n),
      downloadBytes: Number(monthUsage._sum.downloadBytes ?? 0n),
    },
    servers: [...serverMap.values()],
    configurations: user.assignments.map((assignment) => ({
      assignmentId: assignment.id,
      configId: assignment.config.id,
      name: assignment.config.name,
      protocol: assignment.config.type,
      status: assignment.status,
      serverName: assignment.config.server?.name ?? '—',
      serverLocation: assignment.config.server?.location ?? null,
      shareLink: assignment.shareLink,
      trafficUsedBytes: Number(assignment.trafficUsedBytes),
    })),
    usageOverTime: usageSeries.map((bucket) => ({
      bucket: bucket.bucket,
      totalBytes: bucket.totalBytes,
    })),
    devices: user.devices.map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      status: device.status,
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Resolve which dashboard a caller should land on. Staff land on the admin
 * dashboard, end users on their personal one.
 */
export function dashboardFor(actor: ActorContext): 'admin' | 'user' {
  return isStaff(actor.role) ? 'admin' : 'user';
}

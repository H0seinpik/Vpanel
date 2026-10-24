import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { TrafficSample } from '@/services/providers';

/**
 * Traffic accounting.
 *
 * `TrafficUsage` is the append-only ledger; user/server/assignment counters are
 * derived aggregates kept in sync here. Collection is idempotent per
 * `windowKey`: re-processing the same window applies only the *difference*, so
 * a retried worker run never inflates usage.
 *
 * The browser is never a source of truth — all writes originate from the
 * traffic worker or the (authenticated, staff-only) manual import endpoint.
 */

export interface RecordResult {
  windows: number;
  appliedBytes: bigint;
  created: number;
}

export async function recordTrafficSamples(samples: TrafficSample[]): Promise<RecordResult> {
  let created = 0;
  let appliedBytes = 0n;
  let windows = 0;

  for (const sample of samples) {
    const newTotal = sample.uploadBytes + sample.downloadBytes;

    // Locate the existing ledger row for this exact window.
    const existing = await prisma.trafficUsage.findFirst({
      where: {
        serverId: sample.serverId,
        userId: sample.userId,
        configId: sample.configId,
        windowKey: sample.windowKey,
      },
    });

    // Only the *difference* is applied downstream → idempotent by construction.
    const delta = existing ? newTotal - existing.totalBytes : newTotal;

    if (existing) {
      await prisma.trafficUsage.update({
        where: { id: existing.id },
        data: {
          uploadBytes: sample.uploadBytes,
          downloadBytes: sample.downloadBytes,
          totalBytes: newTotal,
          timestamp: new Date(),
        },
      });
    } else {
      await prisma.trafficUsage.create({
        data: {
          serverId: sample.serverId,
          userId: sample.userId,
          configId: sample.configId,
          uploadBytes: sample.uploadBytes,
          downloadBytes: sample.downloadBytes,
          totalBytes: newTotal,
          source: sample.source,
          windowKey: sample.windowKey,
        },
      });
      created += 1;
    }

    windows += 1;
    if (delta === 0n) continue;
    appliedBytes += delta;

    // --- Derived counters ---------------------------------------------------
    if (sample.userId) {
      await prisma.user.update({
        where: { id: sample.userId },
        data: { trafficUsedBytes: { increment: delta } },
      });

        if (sample.configId) {
          await prisma.configAssignment.updateMany({
            where: { configId: sample.configId, userId: sample.userId },
            data: { trafficUsedBytes: { increment: delta } },
          });

          // The configuration keeps its own running total: it is the figure the
          // enforcement pass compares against the configuration's own ceiling.
          await prisma.configuration.update({
            where: { id: sample.configId },
            data: { trafficUsedBytes: { increment: delta } },
          });
        }

      await prisma.subscription.updateMany({
        where: { userId: sample.userId, status: 'ACTIVE' },
        data: { trafficUsedBytes: { increment: delta } },
      });
    }

    if (sample.serverId) {
      await prisma.server.update({
        where: { id: sample.serverId },
        data: { totalBandwidthBytes: { increment: delta } },
      });
    }
  }

  return { windows, appliedBytes, created };
}

// -----------------------------------------------------------------------------
// Recompute (repair) helpers — used if counters ever drift from the ledger
// -----------------------------------------------------------------------------

export async function recomputeUserTraffic(userId: string): Promise<bigint> {
  const aggregate = await prisma.trafficUsage.aggregate({
    where: { userId },
    _sum: { totalBytes: true },
  });
  const total = aggregate._sum.totalBytes ?? 0n;
  await prisma.user.update({ where: { id: userId }, data: { trafficUsedBytes: total } });
  return total;
}

export async function recomputeServerBandwidth(serverId: string): Promise<bigint> {
  const aggregate = await prisma.trafficUsage.aggregate({
    where: { serverId },
    _sum: { totalBytes: true },
  });
  const total = aggregate._sum.totalBytes ?? 0n;
  await prisma.server.update({ where: { id: serverId }, data: { totalBandwidthBytes: total } });
  return total;
}

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

export interface TrafficFilter {
  userId?: string;
  serverId?: string;
  configId?: string;
  from?: Date;
  to?: Date;
}

export type Granularity = 'hour' | 'day' | 'month';

const GRANULARITY_UNITS: Record<Granularity, string> = {
  hour: 'hour',
  day: 'day',
  month: 'month',
};

export interface TrafficBucket {
  bucket: string;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
}

function buildConditions(filter: TrafficFilter): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filter.userId) conditions.push(Prisma.sql`"userId" = ${filter.userId}`);
  if (filter.serverId) conditions.push(Prisma.sql`"serverId" = ${filter.serverId}`);
  if (filter.configId) conditions.push(Prisma.sql`"configId" = ${filter.configId}`);
  if (filter.from) conditions.push(Prisma.sql`"timestamp" >= ${filter.from}`);
  if (filter.to) conditions.push(Prisma.sql`"timestamp" <= ${filter.to}`);
  return conditions;
}

/** Time-bucketed usage series for charts. */
export async function getTrafficSeries(
  filter: TrafficFilter,
  granularity: Granularity = 'day',
): Promise<TrafficBucket[]> {
  const unit = GRANULARITY_UNITS[granularity] ?? 'day';
  const conditions = buildConditions(filter);
  const whereClause = conditions.length
    ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{ bucket: Date; upload: bigint; download: bigint; total: bigint }>
  >(Prisma.sql`
    SELECT date_trunc(${unit}, "timestamp") AS bucket,
           COALESCE(SUM("uploadBytes"), 0)::bigint   AS upload,
           COALESCE(SUM("downloadBytes"), 0)::bigint AS download,
           COALESCE(SUM("totalBytes"), 0)::bigint    AS total
    FROM "traffic_usage"
    ${whereClause}
    GROUP BY bucket
    ORDER BY bucket ASC
  `);

  return rows.map((row) => ({
    bucket: new Date(row.bucket).toISOString(),
    uploadBytes: Number(row.upload),
    downloadBytes: Number(row.download),
    totalBytes: Number(row.total),
  }));
}

export interface TrafficTotals {
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
  recordCount: number;
}

export async function getTrafficTotals(filter: TrafficFilter): Promise<TrafficTotals> {
  const conditions = buildConditions(filter);
  const whereClause = conditions.length
    ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{ upload: bigint; download: bigint; total: bigint; count: bigint }>
  >(Prisma.sql`
    SELECT COALESCE(SUM("uploadBytes"), 0)::bigint   AS upload,
           COALESCE(SUM("downloadBytes"), 0)::bigint AS download,
           COALESCE(SUM("totalBytes"), 0)::bigint    AS total,
           COUNT(*)::bigint                          AS count
    FROM "traffic_usage"
    ${whereClause}
  `);

  const row = rows[0];
  return {
    uploadBytes: Number(row?.upload ?? 0n),
    downloadBytes: Number(row?.download ?? 0n),
    totalBytes: Number(row?.total ?? 0n),
    recordCount: Number(row?.count ?? 0n),
  };
}

export interface LeaderboardRow {
  id: string;
  label: string;
  totalBytes: number;
  uploadBytes: number;
  downloadBytes: number;
}

/** Top consumers by user — drives the "traffic by user" chart. */
export async function getTopUsers(
  filter: TrafficFilter,
  limit = 8,
): Promise<LeaderboardRow[]> {
  const conditions = [...buildConditions(filter), Prisma.sql`"userId" IS NOT NULL`];
  const rows = await prisma.$queryRaw<
    Array<{ id: string; label: string; upload: bigint; download: bigint; total: bigint }>
  >(Prisma.sql`
    SELECT t."userId" AS id,
           COALESCE(u."displayName", u."username") AS label,
           COALESCE(SUM(t."uploadBytes"), 0)::bigint   AS upload,
           COALESCE(SUM(t."downloadBytes"), 0)::bigint AS download,
           COALESCE(SUM(t."totalBytes"), 0)::bigint    AS total
    FROM "traffic_usage" t
    JOIN "users" u ON u."id" = t."userId"
    WHERE ${Prisma.join(conditions, ' AND ')}
    GROUP BY t."userId", u."displayName", u."username"
    ORDER BY total DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    totalBytes: Number(row.total),
    uploadBytes: Number(row.upload),
    downloadBytes: Number(row.download),
  }));
}

/** Top consumers by server — drives the "traffic by server" chart. */
export async function getTopServers(
  filter: TrafficFilter,
  limit = 8,
): Promise<LeaderboardRow[]> {
  const conditions = [...buildConditions(filter), Prisma.sql`"serverId" IS NOT NULL`];
  const rows = await prisma.$queryRaw<
    Array<{ id: string; label: string; upload: bigint; download: bigint; total: bigint }>
  >(Prisma.sql`
    SELECT t."serverId" AS id,
           s."name" AS label,
           COALESCE(SUM(t."uploadBytes"), 0)::bigint   AS upload,
           COALESCE(SUM(t."downloadBytes"), 0)::bigint AS download,
           COALESCE(SUM(t."totalBytes"), 0)::bigint    AS total
    FROM "traffic_usage" t
    JOIN "servers" s ON s."id" = t."serverId"
    WHERE ${Prisma.join(conditions, ' AND ')}
    GROUP BY t."serverId", s."name"
    ORDER BY total DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    totalBytes: Number(row.total),
    uploadBytes: Number(row.upload),
    downloadBytes: Number(row.download),
  }));
}

/** Paginated raw ledger rows for the traffic page. */
export async function listTrafficUsage(
  filter: TrafficFilter,
  pagination: { skip: number; take: number },
) {
  const where: Prisma.TrafficUsageWhereInput = {
    ...(filter.userId ? { userId: filter.userId } : {}),
    ...(filter.serverId ? { serverId: filter.serverId } : {}),
    ...(filter.configId ? { configId: filter.configId } : {}),
    ...(filter.from || filter.to
      ? {
          timestamp: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.trafficUsage.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip: pagination.skip,
      take: pagination.take,
      include: {
        user: { select: { id: true, username: true, displayName: true } },
        server: { select: { id: true, name: true } },
        config: { select: { id: true, name: true } },
      },
    }),
    prisma.trafficUsage.count({ where }),
  ]);

  return { items, total };
}

/** Start of the current calendar month (UTC) — used by "this month" widgets. */
export function startOfMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0));
}

export function daysAgo(days: number, from = new Date()): Date {
  return new Date(from.getTime() - days * 86_400_000);
}

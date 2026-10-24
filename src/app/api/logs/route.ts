import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withAuth } from '@/lib/api/handler';
import { jsonPaginated, paginate, parsePagination } from '@/lib/api/response';
import { auditQuerySchema } from '@/lib/validation';
import { serializeAuditLog } from '@/server/serializers';

/**
 * GET /api/logs — filtered, paginated audit trail (logs:read).
 *
 * Filters: free-text search, exact action, actor, target type, and date range.
 */
export const GET = withAuth(
  async (req) => {
    const url = new URL(req.url);
    const query = auditQuerySchema.parse(Object.fromEntries(url.searchParams));
    const pagination = parsePagination(url, { page: 1, pageSize: 30, maxPageSize: 200 });

    const where: Prisma.AuditLogWhereInput = {};
    if (query.action) where.action = query.action;
    if (query.actorId) where.actorId = query.actorId;
    if (query.targetType) where.targetType = query.targetType;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      };
    }
    if (query.search) {
      where.OR = [
        { action: { contains: query.search, mode: 'insensitive' } },
        { actorName: { contains: query.search, mode: 'insensitive' } },
        { targetId: { contains: query.search, mode: 'insensitive' } },
        { ip: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [items, total, actions] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
        include: { actor: { select: { id: true, username: true, displayName: true } } },
      }),
      prisma.auditLog.count({ where }),
      // Distinct actions power the filter dropdown.
      prisma.auditLog.groupBy({ by: ['action'], _count: { _all: true }, orderBy: { action: 'asc' } }),
    ]);

    const response = jsonPaginated(
      paginate(items.map(serializeAuditLog), total, pagination.page, pagination.pageSize),
    );
    const body = await response.json();
    return Response.json({
      ...body,
      filters: { actions: actions.map((a) => ({ action: a.action, count: a._count._all })) },
    });
  },
  { capability: 'logs:read', rate: 'read' },
);

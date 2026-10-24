import { ServerStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { serializeServer } from '@/server/serializers';
import { getServerCounters } from '@/server/services/server-service';

/**
 * GET /api/monitoring
 *
 * Fleet-wide health view: every registered server with its live metrics and a
 * short recent history for sparklines. Only servers in the administrator's own
 * list are included.
 */
export const GET = withAuth(
  async () => {
    const servers = await prisma.server.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: {
        metrics: { orderBy: { sampledAt: 'desc' }, take: 30 },
        _count: { select: { configs: true } },
      },
    });

    const counters = await getServerCounters();

    // Aggregate active-user count per server from the cached counters.
    const activeUsers = servers.reduce((sum, server) => sum + (server.activeUsers ?? 0), 0);
    const activeConnections = servers.reduce((sum, server) => sum + (server.activeConnections ?? 0), 0);

    const offline = servers.filter((s) => s.status === ServerStatus.OFFLINE).length;
    const warning = servers.filter((s) => s.status === ServerStatus.WARNING).length;

    return jsonOk({
      counters: {
        ...counters,
        activeUsers,
        activeConnections,
        healthScore:
          counters.total === 0
            ? 100
            : Math.round(((counters.total - offline) / counters.total) * 100),
      },
      servers: servers.map((server) => ({
        ...serializeServer(server),
        configCount: server._count.configs,
        history: server.metrics
          .map((metric) => ({
            cpuPercent: metric.cpuPercent,
            memPercent: metric.memPercent,
            activeConnections: metric.activeConnections,
            sampledAt: metric.sampledAt.toISOString(),
          }))
          .reverse(),
      })),
      statusSummary: {
        online: counters.online,
        offline: counters.offline,
        warning,
        disabled: counters.disabled,
      },
      generatedAt: new Date().toISOString(),
    });
  },
  { capability: 'monitoring:read', rate: 'read' },
);

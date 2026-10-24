import { readJson, withAuth } from '@/lib/api/handler';
import { jsonNoContent, jsonOk } from '@/lib/api/response';
import { updateServerSchema } from '@/lib/validation';
import { serializeConfig, serializeServer } from '@/server/serializers';
import {
  deleteServer,
  getServerDetail,
  updateServer,
} from '@/server/services/server-service';

/**
 * GET    /api/servers/:id  — server detail incl. configs + recent metrics
 * PATCH  /api/servers/:id  — update
 * DELETE /api/servers/:id  — delete (cascades to its configurations)
 */
export const GET = withAuth<{ id: string }>(
  async (_req, { params }) => {
    const detail = await getServerDetail(params.id);

    return jsonOk({
      server: serializeServer(detail),
      configurations: detail.configs.map((config) => serializeConfig(config)),
      metrics: detail.metrics.map((metric) => ({
        id: metric.id,
        cpuPercent: metric.cpuPercent,
        memPercent: metric.memPercent,
        activeConnections: metric.activeConnections,
        activeUsers: metric.activeUsers,
        netInBytes: Number(metric.netInBytes),
        netOutBytes: Number(metric.netOutBytes),
        sampledAt: metric.sampledAt.toISOString(),
      })),
      counters: detail._count,
    });
  },
  { capability: 'servers:read', rate: 'read' },
);

export const PATCH = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const input = updateServerSchema.parse(await readJson(req));
    const updated = await updateServer(params.id, input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return jsonOk(serializeServer(updated));
  },
  { capability: 'servers:write', rate: 'write' },
);

export const DELETE = withAuth<{ id: string }>(
  async (_req, { user, params, meta }) => {
    await deleteServer(params.id, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonNoContent();
  },
  { capability: 'servers:delete', rate: 'write' },
);

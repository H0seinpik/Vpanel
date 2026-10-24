import { readJson, withAuth } from '@/lib/api/handler';
import { jsonNoContent, jsonOk } from '@/lib/api/response';
import { updateTunnelSchema } from '@/lib/validation';
import { serializeTunnel } from '@/server/serializers';
import { deleteTunnel, getTunnel, updateTunnel } from '@/server/services/tunnel-service';

/**
 * GET    /api/tunnels/:id — tunnel detail (tunnels:read)
 * PATCH  /api/tunnels/:id — update / enable / disable (tunnels:write)
 * DELETE /api/tunnels/:id — delete and stop forwarding (tunnels:delete)
 */
export const GET = withAuth<{ id: string }>(
  async (_req, { params }) => {
    const tunnel = await getTunnel(params.id);
    return jsonOk(serializeTunnel(tunnel));
  },
  { capability: 'tunnels:read', rate: 'read' },
);

export const PATCH = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const input = updateTunnelSchema.parse(await readJson(req));
    const updated = await updateTunnel(params.id, input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return jsonOk(serializeTunnel(updated));
  },
  { capability: 'tunnels:write', rate: 'write' },
);

export const DELETE = withAuth<{ id: string }>(
  async (_req, { user, params, meta }) => {
    await deleteTunnel(params.id, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonNoContent();
  },
  { capability: 'tunnels:delete', rate: 'write' },
);

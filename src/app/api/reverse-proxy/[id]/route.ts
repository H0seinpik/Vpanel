import { readJson, withAuth } from '@/lib/api/handler';
import { jsonNoContent, jsonOk } from '@/lib/api/response';
import { updateReverseProxySchema } from '@/lib/validation/advanced';
import {
  deleteReverseProxy,
  getReverseProxy,
  updateReverseProxy,
} from '@/server/services/advanced-routing-service';

/** GET / PATCH / DELETE one reverse-proxy bridge/portal row. */
export const GET = withAuth<{ id: string }>(
  async (_req, { params }) => jsonOk(await getReverseProxy(params.id)),
  { anyOf: ['configs:read'], rate: 'read' },
);

export const PATCH = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const input = updateReverseProxySchema.parse(await readJson(req));
    const updated = await updateReverseProxy(params.id, input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonOk(updated);
  },
  { capability: 'configs:write', rate: 'write' },
);

export const DELETE = withAuth<{ id: string }>(
  async (_req, { user, params, meta }) => {
    await deleteReverseProxy(params.id, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return jsonNoContent();
  },
  { capability: 'configs:delete', rate: 'write' },
);

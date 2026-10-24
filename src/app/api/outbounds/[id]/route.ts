import { readJson, withAuth } from '@/lib/api/handler';
import { jsonNoContent, jsonOk } from '@/lib/api/response';
import { updateOutboundSchema } from '@/lib/validation/advanced';
import {
  deleteOutbound,
  getOutbound,
  updateOutbound,
} from '@/server/services/advanced-routing-service';

/** GET / PATCH / DELETE one raw outbound. */
export const GET = withAuth<{ id: string }>(
  async (_req, { params }) => jsonOk(await getOutbound(params.id)),
  { anyOf: ['configs:read'], rate: 'read' },
);

export const PATCH = withAuth<{ id: string }>(
  async (req, { user, params, meta }) => {
    const input = updateOutboundSchema.parse(await readJson(req));
    const updated = await updateOutbound(params.id, input, {
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
    await deleteOutbound(params.id, {
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

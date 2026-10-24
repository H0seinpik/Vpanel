import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonPaginated, paginate, parsePagination } from '@/lib/api/response';
import { configQuerySchema, createConfigSchema } from '@/lib/validation';
import { serializeConfig } from '@/server/serializers';
import { createConfig, getConfigArtifact, listConfigs } from '@/server/services/config-service';

/**
 * GET  /api/configs — list (staff see all, users see only their assignments)
 * POST /api/configs — generate a configuration and assign it to user(s)
 *
 * POST response includes the rendered artefact for the owner so the wizard can
 * immediately show a QR code without a second round-trip.
 */
export const GET = withAuth(
  async (req, { user }) => {
    const url = new URL(req.url);
    const query = configQuerySchema.parse(Object.fromEntries(url.searchParams));
    const pagination = parsePagination(url);

    const { items, total } = await listConfigs(query, pagination, {
      id: user.id,
      username: user.username,
      role: user.role,
    });

    return jsonPaginated(
      paginate(
        items.map((config) => serializeConfig(config)),
        total,
        pagination.page,
        pagination.pageSize,
      ),
    );
  },
  { anyOf: ['configs:read', 'self:configs'], rate: 'read' },
);

export const POST = withAuth(
  async (req, { user, meta }) => {
    const input = createConfigSchema.parse(await readJson(req));

    const actor = {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    };

    const { config, assignments } = await createConfig(input, actor);

    // Render the owner's artefact so the wizard can display it right away.
    let artifact = null;
    if (config.ownerId) {
      try {
        artifact = await getConfigArtifact(config.id, actor, config.ownerId);
      } catch {
        artifact = null;
      }
    }

    return jsonCreated({
      config: serializeConfig(
        { ...config, _count: { assignments: assignments.length } },
        { includeShareLink: true },
      ),
      assignments: assignments.map((assignment) => ({
        id: assignment.id,
        userId: assignment.userId,
        shareLink: assignment.shareLink,
      })),
      artifact,
    });
  },
  { capability: 'configs:write', rate: 'write' },
);

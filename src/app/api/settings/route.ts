import { readJson, withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/api/errors';
import { generalSettingsSchema, securitySettingsSchema, updateSettingsSchema } from '@/lib/validation';
import { getSettings, updateSettings } from '@/server/services/settings-service';

/**
 * GET   /api/settings — the full merged settings tree (settings:read)
 * PATCH /api/settings — update one or more categories (settings:write)
 *
 * The security category additionally requires `settings:security:write`, which
 * only the ADMIN role holds. An OPERATOR attempting it receives a 403.
 */
export const GET = withAuth(
  async () => {
    const settings = await getSettings();
    return jsonOk(settings);
  },
  { capability: 'settings:read', rate: 'read' },
);

export const PATCH = withAuth(
  async (req, { user, meta }) => {
    const body = updateSettingsSchema.parse(await readJson(req));

    // Validate the general + security payloads against their strict schemas.
    if (body.general) generalSettingsSchema.parse(body.general);
    if (body.security) securitySettingsSchema.parse(body.security);

    // Security settings are admin-only, even for operators with settings:write.
    const touchesSecurity = Boolean(body.security) && Object.keys(body.security ?? {}).length > 0;
    if (touchesSecurity && user.role !== 'ADMIN') {
      throw new ForbiddenError('Only administrators can change security settings.');
    }

    const updated = await updateSettings(
      body as Record<string, Record<string, unknown>>,
      { id: user.id, username: user.username },
      { security: touchesSecurity },
    );

    return jsonOk(updated);
  },
  { capability: 'settings:write', rate: 'write' },
);

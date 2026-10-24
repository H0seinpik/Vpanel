import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { capabilitiesFor } from '@/lib/auth/rbac';
import { getSettings } from '@/server/services/settings-service';

/**
 * GET /api/auth/me
 *
 * Returns the authenticated user's profile plus the capabilities their role
 * grants. The frontend uses these only to decide what to *show*; every route
 * re-checks permissions server-side.
 */
export const GET = withAuth(async (_req, { user }) => {
  const settings = await getSettings();

  return jsonOk({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      expirationDate: user.expirationDate?.toISOString() ?? null,
      trafficUsedBytes: Number(user.trafficUsedBytes),
      trafficLimitBytes: user.trafficLimitBytes === null ? null : Number(user.trafficLimitBytes),
    },
    capabilities: capabilitiesFor(user.role),
    app: {
      name: settings.general.appName,
      branding: settings.branding,
    },
  });
});

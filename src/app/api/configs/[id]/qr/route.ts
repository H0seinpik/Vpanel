import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { generateQrPngBuffer, generateQrSvg } from '@/lib/qr';
import { getConfigArtifact } from '@/server/services/config-service';

/**
 * GET /api/configs/:id/qr
 *
 * Query params:
 *   userId — staff only: render the credential of a specific assigned user
 *   format — `png` (default, image/png) | `svg` | `json` (returns the payload)
 *
 * `getConfigArtifact` enforces that a regular user can only render their OWN
 * credential, so this endpoint never leaks another user's configuration.
 */
export const GET = withAuth<{ id: string }>(
  async (req, { user, params }) => {
    const url = new URL(req.url);
    const targetUserId = url.searchParams.get('userId') ?? undefined;
    const format = (url.searchParams.get('format') ?? 'png').toLowerCase();

    const artifact = await getConfigArtifact(
      params.id,
      { id: user.id, username: user.username, role: user.role },
      targetUserId,
    );

    if (format === 'json') {
      return jsonOk({
        payload: artifact.qrPayload,
        shareLink: artifact.shareLink,
        protocol: artifact.protocol,
        forUserId: artifact.forUserId,
      });
    }

    if (format === 'svg') {
      const svg = await generateQrSvg(artifact.qrPayload);
      return new Response(svg, {
        headers: {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    const buffer = await generateQrPngBuffer(artifact.qrPayload);
    return new Response(new Uint8Array(buffer), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-disposition': `inline; filename="qr-${artifact.configName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png"`,
      },
    });
  },
  { anyOf: ['configs:read', 'self:configs'], rate: 'read' },
);

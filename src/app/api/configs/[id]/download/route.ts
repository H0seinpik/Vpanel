import { withAuth } from '@/lib/api/handler';
import { getConfigArtifact } from '@/server/services/config-service';

/**
 * GET /api/configs/:id/download?userId=&format=
 *
 *   format=json (default) — the full client configuration file
 *   format=link           — a .txt file containing the import URL
 *   format=qr             — a PNG QR code
 *
 * Ownership is enforced inside `getConfigArtifact`: a regular user can only ever
 * download their own credential.
 */
export const GET = withAuth<{ id: string }>(
  async (req, { user, params }) => {
    const url = new URL(req.url);
    const targetUserId = url.searchParams.get('userId') ?? undefined;
    const format = (url.searchParams.get('format') ?? 'json').toLowerCase();

    const artifact = await getConfigArtifact(
      params.id,
      { id: user.id, username: user.username, role: user.role },
      targetUserId,
    );

    const safeName = artifact.configName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

    if (format === 'link') {
      return new Response(`${artifact.shareLink}\n`, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="${safeName}.txt"`,
          'cache-control': 'no-store',
        },
      });
    }

    if (format === 'qr') {
      const { generateQrPngBuffer } = await import('@/lib/qr');
      const buffer = await generateQrPngBuffer(artifact.qrPayload);
      return new Response(new Uint8Array(buffer), {
        headers: {
          'content-type': 'image/png',
          'content-disposition': `attachment; filename="${safeName}-qr.png"`,
          'cache-control': 'no-store',
        },
      });
    }

    return new Response(artifact.fileContent, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${artifact.filename}"`,
        'cache-control': 'no-store',
      },
    });
  },
  { anyOf: ['configs:read', 'self:configs'], rate: 'read' },
);

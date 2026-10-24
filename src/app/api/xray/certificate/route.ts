import { existsSync } from 'node:fs';
import { jsonOk } from '@/lib/api/response';
import { withAuth } from '@/lib/api/handler';
import { buildCertificateStatus } from '@/server/services/certificate-status';
import {
  certificatePin,
  getCertificatePaths,
  getXrayStatus,
} from '@/server/services/xray-service';

/**
 * GET /api/xray/certificate
 *
 * Reports the TLS certificate the node presents, so the wizard can tell the
 * operator up front that their TLS configurations have something to serve with.
 *
 * Read-only, and no secret is exposed: a certificate is public by nature (every
 * client receives it), and only the private key's *path* is returned — never its
 * contents.
 *
 * NOTE FOR CALLERS: this returns a bare `{ data: CertificateStatus }` with no
 * sibling keys, so `api.get()` unwraps it — `useApi` gives you the
 * `CertificateStatus` directly, NOT an object with a `.data` property.
 */
export const GET = withAuth(
  async () => {
    const status = await getXrayStatus();

    return jsonOk(
      buildCertificateStatus(getCertificatePaths(), {
        fileExists: existsSync,
        readPin: certificatePin,
        nodeRunning: status.running,
      }),
    );
  },
  { anyOf: ['configs:read', 'configs:write', 'self:configs'], rate: 'read' },
);

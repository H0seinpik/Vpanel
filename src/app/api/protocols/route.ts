import { withAuth } from '@/lib/api/handler';
import { jsonOk } from '@/lib/api/response';
import { getProtocolFields, listProtocols, SUPPORTED_PROTOCOLS } from '@/services/config-generator';

/**
 * GET /api/protocols
 *
 * Exposes the protocol catalog AND the field descriptors that drive the
 * configuration wizard. The frontend renders its form from this metadata, so
 * the configuration format is never hard-coded in the UI.
 */
export const GET = withAuth(
  async (req) => {
    const url = new URL(req.url);
    const type = url.searchParams.get('type');

    if (type) {
      const upper = type.toUpperCase();
      if (!SUPPORTED_PROTOCOLS.includes(upper as never)) {
        return jsonOk({ protocols: listProtocols(), fields: [] });
      }
      return jsonOk({ protocol: upper, fields: getProtocolFields(upper) });
    }

    return jsonOk({
      protocols: listProtocols().map((protocol) => ({
        ...protocol,
        fields: getProtocolFields(protocol.type),
      })),
    });
  },
  { anyOf: ['configs:read', 'configs:write', 'self:configs'], rate: 'read' },
);

import { generateConfig } from '../config-generator';
import type { ConfigurationProvider, DeliveredConfiguration } from './types';

/**
 * CONFIGURATION PROVIDER — thin adapter over the config-generator engine.
 *
 * Kept as a provider so a future deployment could render configurations through
 * a different engine (e.g. a remote signing service) without touching the
 * business layer. The default implementation is pure and side-effect free.
 */
export class LocalConfigurationProvider implements ConfigurationProvider {
  readonly name = 'local';

  render(
    protocol: string,
    params: Record<string, unknown>,
    name: string,
  ): DeliveredConfiguration {
    const generated = generateConfig(protocol, params, { name });
    return {
      shareLink: generated.shareLink,
      qrPayload: generated.qrPayload,
      filename: generated.filename,
      fileContent: generated.fileContent,
      outbound: generated.outbound,
      serverInbound: generated.serverInbound,
      warnings: generated.warnings,
    };
  }
}

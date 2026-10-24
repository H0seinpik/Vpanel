import { getEnv } from '@/lib/env';
import { AgentNodeProvider, AgentServerProvider, AgentTrafficProvider } from './agent';
import { LocalConfigurationProvider } from './configuration';
import { LocalNodeProvider, LocalServerProvider, LocalTrafficProvider } from './local';
import type { ProviderRegistry } from './types';

export * from './types';
export { LocalConfigurationProvider } from './configuration';

let cached: ProviderRegistry | null = null;

/**
 * Resolve the active provider set from configuration.
 *
 * `NODE_PROVIDER=local` (default) → no outbound calls, safe for dev.
 * `NODE_PROVIDER=agent`           → HTTPS to each registered node's agent.
 *
 * Servers without an `agentEndpoint` always fall back to the local provider,
 * so a mixed fleet (some agent-managed, some manual) works without extra config.
 */
export function getProviders(): ProviderRegistry {
  if (cached) return cached;

  const env = getEnv();
  const options = {
    sharedSecret: env.AGENT_SHARED_SECRET || undefined,
  };

  if (env.NODE_PROVIDER === 'agent') {
    const node = new AgentNodeProvider(options);
    cached = {
      node,
      traffic: new AgentTrafficProvider(options),
      server: new AgentServerProvider(node),
      configuration: new LocalConfigurationProvider(),
    };
    return cached;
  }

  const node = new LocalNodeProvider();
  cached = {
    node,
    traffic: new LocalTrafficProvider(),
    server: new LocalServerProvider(node),
    configuration: new LocalConfigurationProvider(),
  };
  return cached;
}

/** Test seam — resets the memoised registry. */
export function resetProviders() {
  cached = null;
}

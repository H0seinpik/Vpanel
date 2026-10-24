import type {
  ConnectionTestResult,
  CredentialRef,
  NodeProvider,
  NodeStatus,
  ServerHealth,
  ServerProvider,
  ServerRef,
  TrafficCollectionContext,
  TrafficProvider,
  TrafficSample,
} from './types';

/**
 * AGENT PROVIDER — production transport.
 *
 * Speaks to a VPanel agent that runs ON the registered node. The panel only ever
 * contacts hosts that an administrator explicitly added, and only over the
 * configured `agentEndpoint`, authenticated with a per-server token.
 *
 * The agent contract (implement on the node side):
 *   GET  {endpoint}/health                     → { version, uptimeSeconds }
 *   GET  {endpoint}/status                     → NodeStatus
 *   POST {endpoint}/clients                    → add/refresh a credential
 *   DELETE {endpoint}/clients                  → revoke a credential
 *   GET  {endpoint}/traffic?since=<iso>        → TrafficSample[] (bytes as strings)
 *
 * BigInts are transported as decimal strings to avoid JSON precision loss.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

interface AgentOptions {
  /** Shared secret the panel sends as a bearer token. */
  sharedSecret?: string;
  timeoutMs?: number;
}

function resolveEndpoint(server: ServerRef): string | null {
  const endpoint = server.agentEndpoint?.trim();
  if (!endpoint) return null;
  return endpoint.replace(/\/+$/, '');
}

async function agentFetch<T>(
  server: ServerRef,
  path: string,
  options: AgentOptions,
  init?: RequestInit,
): Promise<T> {
  const endpoint = resolveEndpoint(server);
  if (!endpoint) {
    throw new Error(`Server "${server.name}" has no agent endpoint configured.`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const token = server.agentToken || options.sharedSecret || '';

  try {
    const response = await fetch(`${endpoint}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Agent responded ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const toBigInt = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.round(value));
  if (typeof value === 'string' && value.trim() !== '') return BigInt(value);
  return 0n;
};

export class AgentNodeProvider implements NodeProvider {
  readonly name = 'agent';

  constructor(private readonly options: AgentOptions = {}) {}

  async testConnection(server: ServerRef): Promise<ConnectionTestResult> {
    const started = Date.now();
    if (!resolveEndpoint(server)) {
      return { ok: false, message: 'No agent endpoint configured for this server.' };
    }
    try {
      const health = await agentFetch<{ version?: string; uptimeSeconds?: number }>(
        server,
        '/health',
        this.options,
      );
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: `Agent reachable (version ${health.version ?? 'unknown'}).`,
        details: health as Record<string, unknown>,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : 'Agent unreachable.',
      };
    }
  }

  async fetchStatus(server: ServerRef): Promise<NodeStatus> {
    try {
      const raw = await agentFetch<Record<string, unknown>>(server, '/status', this.options);
      return {
        online: Boolean(raw.online ?? true),
        cpuPercent: raw.cpuPercent as number | undefined,
        memPercent: raw.memPercent as number | undefined,
        activeConnections: raw.activeConnections as number | undefined,
        activeUsers: raw.activeUsers as number | undefined,
        netInBytes: toBigInt(raw.netInBytes),
        netOutBytes: toBigInt(raw.netOutBytes),
        uptimeSeconds: raw.uptimeSeconds as number | undefined,
        version: raw.version as string | undefined,
        error: raw.error as string | undefined,
      };
    } catch (error) {
      return {
        online: false,
        error: error instanceof Error ? error.message : 'Agent unreachable.',
      };
    }
  }

  async applyClient(
    server: ServerRef,
    inboundTag: string,
    credential: CredentialRef,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      const result = await agentFetch<{ ok?: boolean; message?: string }>(
        server,
        '/clients',
        this.options,
        { method: 'POST', body: JSON.stringify({ inboundTag, credential }) },
      );
      return { ok: result.ok ?? true, message: result.message ?? 'Credential applied.' };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to apply credential.',
      };
    }
  }

  async removeClient(
    server: ServerRef,
    inboundTag: string,
    credential: CredentialRef,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      const result = await agentFetch<{ ok?: boolean; message?: string }>(
        server,
        '/clients',
        this.options,
        { method: 'DELETE', body: JSON.stringify({ inboundTag, credential }) },
      );
      return { ok: result.ok ?? true, message: result.message ?? 'Credential revoked.' };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to revoke credential.',
      };
    }
  }
}

export class AgentTrafficProvider implements TrafficProvider {
  readonly name = 'agent';

  constructor(private readonly options: AgentOptions = {}) {}

  async collect(
    server: ServerRef,
    since: Date,
    windowKey: string,
    _context?: TrafficCollectionContext,
  ): Promise<TrafficSample[]> {
    if (!resolveEndpoint(server)) return [];

    // The agent reports usage per client identity (`email`), which is the same
    // value VPanel writes into the inbound client config. The worker maps it
    // back to a userId/configId — the node never needs our internal ids.
    const raw = await agentFetch<
      Array<{
        email?: string | null;
        userId?: string | null;
        configId?: string | null;
        uploadBytes?: string | number;
        downloadBytes?: string | number;
      }>
    >(server, `/traffic?since=${encodeURIComponent(since.toISOString())}`, this.options);

    return (Array.isArray(raw) ? raw : []).map((row) => ({
      serverId: server.id,
      userId: row.userId ?? null,
      configId: row.configId ?? null,
      uploadBytes: toBigInt(row.uploadBytes),
      downloadBytes: toBigInt(row.downloadBytes),
      windowKey,
      source: 'AGENT' as const,
      clientEmail: row.email ?? null,
    }));
  }
}

export class AgentServerProvider implements ServerProvider {
  readonly name = 'agent';

  constructor(private readonly node: NodeProvider) {}

  async checkHealth(server: ServerRef): Promise<ServerHealth> {
    const metrics = await this.node.fetchStatus(server);
    if (!metrics.online) {
      return {
        status: 'OFFLINE',
        lastHeartbeat: null,
        metrics: null,
        error: metrics.error ?? 'Node reported offline.',
      };
    }
    const warning = (metrics.cpuPercent ?? 0) > 85 || (metrics.memPercent ?? 0) > 90;
    return {
      status: warning ? 'WARNING' : 'ONLINE',
      lastHeartbeat: new Date(),
      metrics,
    };
  }
}

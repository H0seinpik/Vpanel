import { createHash } from 'node:crypto';
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
 * LOCAL PROVIDER — development / manual-accounting mode.
 *
 * This provider performs NO outbound network calls. It exists so the entire
 * application is runnable end-to-end without a real node agent:
 *
 *   - `fetchStatus` derives *deterministic simulated* metrics from the server id
 *     so charts and dashboards have plausible, stable data.
 *   - `collect` returns synthetic traffic deltas proportional to the number of
 *     assigned users, again deterministic per window.
 *   - credential apply/remove are recorded as no-ops (the DB remains the source
 *     of truth for assignments).
 *
 * It is intentionally labelled so operators never mistake simulation for real
 * telemetry. Switch `NODE_PROVIDER=agent` for production.
 */

const SIMULATION_LABEL = 'local-simulation';

function seededRandom(seed: string, salt: string): number {
  const hash = createHash('sha256').update(`${seed}:${salt}`).digest();
  // First 4 bytes → [0,1)
  return hash.readUInt32BE(0) / 0xffffffff;
}

function isSimulated(server: ServerRef): boolean {
  // A server with a real agent endpoint should be handled by the agent provider.
  return !server.agentEndpoint;
}

export class LocalNodeProvider implements NodeProvider {
  readonly name = 'local';

  async testConnection(server: ServerRef): Promise<ConnectionTestResult> {
    const started = Date.now();
    if (!server.ipAddress || !server.port) {
      return { ok: false, message: 'Server address/port is incomplete.' };
    }
    if (!isSimulated(server)) {
      return {
        ok: false,
        message:
          'This server has an agent endpoint configured. Set NODE_PROVIDER=agent to probe it.',
      };
    }
    return {
      ok: true,
      latencyMs: Date.now() - started + Math.round(seededRandom(server.id, 'lat') * 40),
      message: `Local provider: ${server.hostname}:${server.port} is registered. (${SIMULATION_LABEL})`,
      details: { mode: SIMULATION_LABEL, simulated: true },
    };
  }

  async fetchStatus(server: ServerRef): Promise<NodeStatus> {
    if (!isSimulated(server)) {
      return { online: false, error: 'Server is configured for the agent provider.' };
    }
    const cpu = Number((seededRandom(server.id, 'cpu') * 55 + 5).toFixed(1));
    const mem = Number((seededRandom(server.id, 'mem') * 60 + 20).toFixed(1));
    return {
      online: true,
      cpuPercent: cpu,
      memPercent: mem,
      activeConnections: Math.round(seededRandom(server.id, 'conn') * 400),
      activeUsers: Math.round(seededRandom(server.id, 'users') * 25),
      netInBytes: BigInt(Math.round(seededRandom(server.id, 'in') * 5 * 1024 ** 3)),
      netOutBytes: BigInt(Math.round(seededRandom(server.id, 'out') * 9 * 1024 ** 3)),
      uptimeSeconds: Math.round(seededRandom(server.id, 'up') * 30 * 86_400),
      version: 'simulated',
    };
  }

  async applyClient(
    _server: ServerRef,
    inboundTag: string,
    credential: CredentialRef,
  ): Promise<{ ok: boolean; message: string }> {
    const id = credential.uuid ?? credential.password ?? credential.email ?? 'client';
    return {
      ok: true,
      message: `Local provider: credential ${String(id).slice(0, 8)}… registered on ${inboundTag} (${SIMULATION_LABEL}).`,
    };
  }

  async removeClient(
    _server: ServerRef,
    inboundTag: string,
    credential: CredentialRef,
  ): Promise<{ ok: boolean; message: string }> {
    const id = credential.uuid ?? credential.password ?? credential.email ?? 'client';
    return {
      ok: true,
      message: `Local provider: credential ${String(id).slice(0, 8)}… removed from ${inboundTag}.`,
    };
  }
}

export class LocalTrafficProvider implements TrafficProvider {
  readonly name = 'local';

  async collect(
    server: ServerRef,
    _since: Date,
    windowKey: string,
    context?: TrafficCollectionContext,
  ): Promise<TrafficSample[]> {
    if (!isSimulated(server)) return [];

    const samples: TrafficSample[] = [];

    // Per-assignment synthetic deltas so the user/server dashboards have data
    // to render in local mode. Deterministic per (assignment, window) — safe to
    // re-run, and the worker applies only differences.
    for (const entry of context?.attribution ?? []) {
      const upload = BigInt(
        Math.round(seededRandom(entry.assignmentId, `up:${windowKey}`) * 12 * 1024 ** 2),
      );
      const download = BigInt(
        Math.round(seededRandom(entry.assignmentId, `down:${windowKey}`) * 48 * 1024 ** 2),
      );
      samples.push({
        serverId: server.id,
        userId: entry.userId,
        configId: entry.configId,
        uploadBytes: upload,
        downloadBytes: download,
        windowKey,
        source: 'AGENT',
        clientEmail: entry.clientEmail,
      });
    }

    // Aggregate, unattributed node overhead.
    const upload = BigInt(Math.round(seededRandom(server.id, `up:${windowKey}`) * 40 * 1024 ** 2));
    const download = BigInt(
      Math.round(seededRandom(server.id, `down:${windowKey}`) * 120 * 1024 ** 2),
    );
    samples.push({
      serverId: server.id,
      userId: null,
      configId: null,
      uploadBytes: upload,
      downloadBytes: download,
      windowKey,
      source: 'AGENT',
      clientEmail: null,
    });

    return samples;
  }
}

export class LocalServerProvider implements ServerProvider {
  readonly name = 'local';

  constructor(private readonly node: NodeProvider) {}

  async checkHealth(server: ServerRef): Promise<ServerHealth> {
    try {
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
    } catch (error) {
      return {
        status: 'OFFLINE',
        lastHeartbeat: null,
        metrics: null,
        error: error instanceof Error ? error.message : 'Unknown provider error',
      };
    }
  }
}

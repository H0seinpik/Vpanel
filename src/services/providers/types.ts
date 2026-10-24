/**
 * Provider abstractions.
 *
 * VPanel never talks to arbitrary Internet hosts. A `NodeProvider` can only act
 * on servers that an administrator has explicitly registered in the database.
 * Every integration point is an interface with two implementations:
 *
 *   - `local`  — built-in simulation/local provider. Safe default for dev and
 *                for panels that only track traffic reported manually. It never
 *                makes outbound network calls.
 *   - `agent`  — talks to a VPanel agent running ON the registered node over
 *                HTTPS, authenticated with a shared secret. Used in production.
 *
 * Adding a new node type or traffic source means implementing one of these
 * interfaces — no other part of the application needs to change.
 */

// -----------------------------------------------------------------------------
// Shared shapes
// -----------------------------------------------------------------------------

/** Minimal server projection the providers need. Never includes secrets. */
export interface ServerRef {
  id: string;
  name: string;
  hostname: string;
  ipAddress: string;
  port: number;
  type: string;
  agentEndpoint?: string | null;
  /** Decrypted agent token, resolved by the caller right before the call. */
  agentToken?: string | null;
}

/** Credential belonging to a single user on a single configuration. */
export interface CredentialRef {
  uuid?: string;
  password?: string;
  email?: string;
}

// -----------------------------------------------------------------------------
// NodeProvider — the transport to a single registered node
// -----------------------------------------------------------------------------

export interface NodeStatus {
  online: boolean;
  cpuPercent?: number;
  memPercent?: number;
  activeConnections?: number;
  activeUsers?: number;
  netInBytes?: bigint;
  netOutBytes?: bigint;
  uptimeSeconds?: number;
  version?: string;
  error?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface NodeProvider {
  readonly name: string;
  /** Reachability + auth probe. Never scans anything beyond the given server. */
  testConnection(server: ServerRef): Promise<ConnectionTestResult>;
  /** Pull current resource + connection metrics from the node. */
  fetchStatus(server: ServerRef): Promise<NodeStatus>;
  /** Push/refresh a client credential for an inbound on the node. */
  applyClient(
    server: ServerRef,
    inboundTag: string,
    credential: CredentialRef,
  ): Promise<{ ok: boolean; message: string }>;
  /** Revoke a client credential from an inbound. */
  removeClient(
    server: ServerRef,
    inboundTag: string,
    credential: CredentialRef,
  ): Promise<{ ok: boolean; message: string }>;
}

// -----------------------------------------------------------------------------
// TrafficProvider — per-node usage collection
// -----------------------------------------------------------------------------

export interface TrafficSample {
  serverId: string;
  /** null = unattributed to a specific user (aggregate node traffic). */
  userId: string | null;
  configId: string | null;
  uploadBytes: bigint;
  downloadBytes: bigint;
  /** Idempotency key for the collection window, e.g. "2026-09-26T14:50". */
  windowKey: string;
  source: 'AGENT' | 'MANUAL' | 'IMPORT';
  /**
   * The client identity the node reports (in Xray this is the inbound client's
   * `email`). The worker resolves it to a userId/configId via ConfigAssignment.
   * Nodes are not required to know VPanel's internal ids.
   */
  clientEmail?: string | null;
}

/** Assignments on a server, supplied so providers can attribute per-client usage. */
export interface AttributionEntry {
  assignmentId: string;
  userId: string;
  configId: string;
  /** Stable identifier written into the node's inbound client config. */
  clientEmail: string;
}

export interface TrafficCollectionContext {
  windowKey: string;
  attribution: AttributionEntry[];
}

export interface TrafficProvider {
  readonly name: string;
  /**
   * Collect deltas since `since`. Implementations MUST be idempotent per
   * `windowKey` so a re-run does not double-count.
   */
  collect(
    server: ServerRef,
    since: Date,
    windowKey: string,
    context?: TrafficCollectionContext,
  ): Promise<TrafficSample[]>;
}

// -----------------------------------------------------------------------------
// ServerProvider — health aggregation for a registered server
// -----------------------------------------------------------------------------

export interface ServerHealth {
  status: 'ONLINE' | 'OFFLINE' | 'WARNING' | 'DISABLED' | 'PENDING';
  lastHeartbeat: Date | null;
  metrics: NodeStatus | null;
  error?: string;
}

export interface ServerProvider {
  readonly name: string;
  /** Derive the persisted status + metrics for one server. */
  checkHealth(server: ServerRef): Promise<ServerHealth>;
}

// -----------------------------------------------------------------------------
// ConfigurationProvider — turns parameters into delivered artefacts
// -----------------------------------------------------------------------------

export interface DeliveredConfiguration {
  shareLink: string;
  qrPayload: string;
  filename: string;
  fileContent: string;
  outbound: Record<string, unknown>;
  serverInbound: Record<string, unknown>;
  warnings: string[];
}

export interface ConfigurationProvider {
  readonly name: string;
  /**
   * Render a configuration for one user. `params` are the validated protocol
   * parameters including the user's own credential.
   */
  render(
    protocol: string,
    params: Record<string, unknown>,
    name: string,
  ): DeliveredConfiguration;
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

export interface ProviderRegistry {
  node: NodeProvider;
  traffic: TrafficProvider;
  server: ServerProvider;
  configuration: ConfigurationProvider;
}

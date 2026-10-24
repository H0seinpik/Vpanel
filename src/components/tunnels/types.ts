/** Shared shapes for the tunnels page and its editor. */

export type TunnelNetwork = 'TCP' | 'UDP' | 'TCP_UDP';

export interface TunnelRow {
  id: string;
  name: string;
  serverId: string;
  listenAddress: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  network: TunnelNetwork;
  enabled: boolean;
  notes: string | null;
  lastError: string | null;
  trafficUpBytes: number;
  trafficDownBytes: number;
  trafficTotalBytes: number;
  server?: {
    id: string;
    name: string;
    hostname: string;
    status: string;
  };
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TunnelServer {
  id: string;
  name: string;
  hostname: string;
  port: number;
  status: string;
}

export interface TunnelRuntime {
  enabled: boolean;
  running: boolean;
  appliedPorts: number[];
  appliedAt: string | null;
}

export interface TunnelCounters {
  total: number;
  enabled: number;
  disabled: number;
  trafficUpBytes: number;
  trafficDownBytes: number;
  trafficTotalBytes: number;
}

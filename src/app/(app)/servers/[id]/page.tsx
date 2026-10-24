'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Cpu,
  HardDrive,
  Network,
  RefreshCw,
  Server as ServerIcon,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useApi } from '@/hooks/use-api';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Skeleton, EmptyState } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/dialog';
import { PageHeader } from '@/components/common/page-header';
import { StatCard } from '@/components/common/stat-card';
import { Tabs, TabsContent, TabsList, TabsTrigger, UsageBar } from '@/components/ui/primitives';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ActiveUsersChart, Sparkline } from '@/components/charts';
import { ConfigActions } from '@/components/configs/config-actions';
import { useToast } from '@/components/ui/toast';

interface ServerDetailResponse {
  server: {
    id: string;
    name: string;
    hostname: string;
    ipAddress: string;
    port: number;
    protocol: string;
    type: string;
    location: string | null;
    status: string;
    description: string | null;
    monitoringEnabled: boolean;
    hasAgent: boolean;
    cpuPercent: number | null;
    memPercent: number | null;
    activeConnections: number;
    activeUsers: number;
    netInBytes: number;
    netOutBytes: number;
    totalBandwidthBytes: number;
    lastHeartbeat: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  };
  configurations: Array<{
    id: string;
    name: string;
    type: string;
    status: string;
    assignmentCount?: number;
    owner: { username: string; displayName: string | null } | null;
  }>;
  metrics: Array<{
    id: string;
    cpuPercent: number | null;
    memPercent: number | null;
    activeConnections: number;
    activeUsers: number;
    netInBytes: number;
    netOutBytes: number;
    sampledAt: string;
  }>;
  counters: { configs: number; trafficUsage: number };
}

/** Server detail: live metrics, configuration inventory and lifecycle actions. */
export default function ServerDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const id = params?.id;
  const { data, loading, error, reload, refreshing } = useApi<ServerDetailResponse>(
    id ? `/api/servers/${id}` : null,
    { refreshInterval: 30_000 },
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  async function run(action: 'test' | 'refresh' | 'toggle') {
    if (!id) return;
    setBusy(action);
    try {
      if (action === 'test') {
        const result = await api.post<{ ok: boolean; message: string; latencyMs?: number }>(
          `/api/servers/${id}/test`,
        );
        result.ok
          ? toast.success('Connection OK', `${result.message}${result.latencyMs ? ` (${result.latencyMs} ms)` : ''}`)
          : toast.warning('Connection failed', result.message);
      } else if (action === 'refresh') {
        await api.post(`/api/servers/${id}/refresh`);
        toast.success('Status refreshed');
      } else {
        const next = data?.server.status === 'DISABLED' ? 'ONLINE' : 'DISABLED';
        await api.patch(`/api/servers/${id}`, { status: next });
        toast.success(next === 'DISABLED' ? 'Server disabled' : 'Server enabled');
      }
      await reload();
    } catch (caught) {
      toast.error('Action failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      await api.delete(`/api/servers/${id}`);
      toast.success('Server deleted');
      router.push('/servers');
    } catch (caught) {
      toast.error('Delete failed', caught instanceof ApiError ? caught.message : undefined);
      setDeleting(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <AlertTriangle className="size-6 text-destructive" />
          <p className="text-sm font-medium">Could not load this server</p>
          <p className="text-sm text-muted-foreground">{error?.message}</p>
          <Button variant="outline" asChild>
            <Link href="/servers">
              <ArrowLeft /> Back to servers
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const server = data.server;
  const metrics = data.metrics;

  return (
    <div className="space-y-6">
      <PageHeader
        title={server.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">
              {server.hostname}:{server.port}
            </span>
            <StatusBadge status={server.status} />
            <StatusBadge status="INFO" label={server.type} />
            {server.location ? <span>· {server.location}</span> : null}
          </span>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/servers">
                <ArrowLeft /> Back
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void run('test')} loading={busy === 'test'}>
              <Zap /> Test connection
            </Button>
            <Button variant="outline" size="sm" onClick={() => void run('refresh')} loading={busy === 'refresh' || refreshing}>
              <RefreshCw /> Refresh
            </Button>
            <Button
              variant={server.status === 'DISABLED' ? 'default' : 'outline'}
              size="sm"
              onClick={() => void run('toggle')}
              loading={busy === 'toggle'}
            >
              {server.status === 'DISABLED' ? 'Enable' : 'Disable'}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete
            </Button>
          </>
        }
      />

      {server.lastError ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">Last reported error</p>
            <p className="text-muted-foreground">{server.lastError}</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="CPU"
          value={server.cpuPercent !== null ? `${Math.round(server.cpuPercent)}%` : '—'}
          icon={Cpu}
          tone={server.cpuPercent && server.cpuPercent > 85 ? 'warning' : 'default'}
          hint={metrics.length ? 'Live sample' : 'No samples yet'}
        />
        <StatCard
          label="Memory"
          value={server.memPercent !== null ? `${Math.round(server.memPercent)}%` : '—'}
          icon={HardDrive}
          tone={server.memPercent && server.memPercent > 90 ? 'destructive' : 'default'}
        />
        <StatCard
          label="Active users"
          value={server.activeUsers}
          icon={Users}
          tone="accent"
          hint={`${server.activeConnections} connections`}
        />
        <StatCard
          label="Total bandwidth"
          value={formatBytes(server.totalBandwidthBytes)}
          icon={Network}
          tone="success"
          hint={`↑ ${formatBytes(server.netInBytes)} · ↓ ${formatBytes(server.netOutBytes)}`}
        />
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="configurations">
            Configurations ({data.counters.configs})
          </TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Server information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <InfoRow label="Hostname" value={<span className="font-mono">{server.hostname}</span>} />
                <InfoRow label="IP address" value={<span className="font-mono">{server.ipAddress}</span>} />
                <InfoRow label="Port" value={server.port} />
                <InfoRow label="Protocol" value={server.protocol} />
                <InfoRow label="Type" value={server.type} />
                <InfoRow label="Location" value={server.location ?? '—'} />
                <InfoRow label="Monitoring" value={server.monitoringEnabled ? 'Enabled' : 'Disabled'} />
                <InfoRow label="Agent" value={server.hasAgent ? 'Configured' : 'Not configured'} />
                <InfoRow label="Last heartbeat" value={formatDateTime(server.lastHeartbeat)} />
                <InfoRow label="Created" value={formatDateTime(server.createdAt)} />
                {server.description ? (
                  <div className="pt-2">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Description</p>
                    <p className="mt-1 text-sm">{server.description}</p>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Live load</CardTitle>
                <CardDescription>Most recent samples from the monitoring worker</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">CPU</span>
                    <span className="tabular-nums">{server.cpuPercent !== null ? `${Math.round(server.cpuPercent)}%` : '—'}</span>
                  </div>
                  <UsageBar percent={server.cpuPercent ?? 0} showLabel />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Memory</span>
                    <span className="tabular-nums">{server.memPercent !== null ? `${Math.round(server.memPercent)}%` : '—'}</span>
                  </div>
                  <UsageBar percent={server.memPercent ?? 0} showLabel />
                </div>

                {metrics.length > 1 ? (
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">CPU history</p>
                    <Sparkline data={[...metrics].reverse()} dataKey="cpuPercent" height={56} />
                  </div>
                ) : (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    Not enough samples yet — check back after a few monitoring intervals.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="configurations">
          <Card className="overflow-hidden">
            {data.configurations.length === 0 ? (
              <EmptyState
                icon={ServerIcon}
                title="No configurations on this server"
                description="Create a configuration and select this node to get started."
                action={
                  <Button size="sm" asChild>
                    <Link href="/configs/new">Create configuration</Link>
                  </Button>
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Protocol</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Assigned users</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[120px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.configurations.map((config) => (
                    <TableRow key={config.id}>
                      <TableCell>
                        <Link href={`/configs/${config.id}`} className="font-medium hover:underline">
                          {config.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status="INFO" label={config.type} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {config.owner?.displayName ?? config.owner?.username ?? '—'}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">{config.assignmentCount ?? 0}</TableCell>
                      <TableCell>
                        <StatusBadge status={config.status} />
                      </TableCell>
                      <TableCell>
                        <ConfigActions
                          configId={config.id}
                          name={config.name}
                          protocol={config.type}
                          compact
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="metrics">
          <Card>
            <CardHeader>
              <CardTitle>Active connections over time</CardTitle>
              <CardDescription>Recorded by the monitoring worker</CardDescription>
            </CardHeader>
            <CardContent>
              {metrics.length > 1 ? (
                <ActiveUsersChart
                  data={[...metrics]
                    .reverse()
                    .map((metric) => ({ bucket: metric.sampledAt, count: metric.activeConnections }))}
                />
              ) : (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  Not enough metric samples yet.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${server.name}"?`}
        description="This permanently removes the server together with all of its configurations and assignments. This cannot be undone."
        confirmLabel="Delete server"
        destructive
        loading={deleting}
        onConfirm={onDelete}
      />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border pb-2 last:border-0">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-right text-sm">{value}</span>
    </div>
  );
}

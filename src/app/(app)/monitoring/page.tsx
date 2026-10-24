'use client';

import * as React from 'react';
import Link from 'next/link';
import { Activity, AlertTriangle, CheckCircle2, Cpu, HardDrive, RefreshCw, Wifi } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useApi } from '@/hooks/use-api';
import { formatBytes, formatRelative } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { StatCard } from '@/components/common/stat-card';
import { UsageBar } from '@/components/ui/primitives';
import { Sparkline, StatusDonutChart } from '@/components/charts';
import { useToast } from '@/components/ui/toast';

interface MonitoringResponse {
  counters: {
    total: number;
    online: number;
    offline: number;
    warning: number;
    disabled: number;
    activeUsers: number;
    activeConnections: number;
    healthScore: number;
  };
  servers: Array<{
    id: string;
    name: string;
    hostname: string;
    port: number;
    location: string | null;
    status: string;
    cpuPercent: number | null;
    memPercent: number | null;
    activeConnections: number;
    activeUsers: number;
    totalBandwidthBytes: number;
    lastHeartbeat: string | null;
    lastError: string | null;
    configCount: number;
    history: Array<{ cpuPercent: number | null; memPercent: number | null; activeConnections: number; sampledAt: string }>;
  }>;
  statusSummary: { online: number; offline: number; warning: number; disabled: number };
  generatedAt: string;
}

/**
 * Monitoring page.
 *
 * Fleet health with per-server CPU/RAM, connections and a short CPU sparkline.
 * Only servers registered in the panel appear here; nothing is scanned.
 */
export default function MonitoringPage() {
  const toast = useToast();
  const { data, loading, error, reload, refreshing } = useApi<MonitoringResponse>('/api/monitoring', {
    refreshInterval: 30_000,
  });

  const [busyId, setBusyId] = React.useState<string | null>(null);

  async function refreshServer(serverId: string) {
    setBusyId(serverId);
    try {
      await api.post(`/api/servers/${serverId}/refresh`);
      toast.success('Status refreshed');
      await reload();
    } catch (caught) {
      toast.error('Refresh failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Monitoring"
        description={`Live infrastructure health · updated ${formatRelative(data?.generatedAt)}`}
        actions={
          <Button variant="outline" size="sm" onClick={() => void reload()} loading={refreshing}>
            <RefreshCw /> Refresh all
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Health score"
          value={`${data?.counters.healthScore ?? '—'}%`}
          icon={CheckCircle2}
          tone={
            (data?.counters.healthScore ?? 100) >= 90
              ? 'success'
              : (data?.counters.healthScore ?? 100) >= 60
                ? 'warning'
                : 'destructive'
          }
          hint={`${data?.counters.total ?? 0} server(s) tracked`}
        />
        <StatCard label="Active users" value={data?.counters.activeUsers ?? '—'} icon={Activity} tone="accent" />
        <StatCard
          label="Active connections"
          value={data?.counters.activeConnections ?? '—'}
          icon={Wifi}
          hint="Across all nodes"
        />
        <StatCard
          label="Attention needed"
          value={(data?.counters.offline ?? 0) + (data?.counters.warning ?? 0)}
          icon={AlertTriangle}
          tone={data && data.counters.offline + data.counters.warning > 0 ? 'warning' : 'default'}
          hint={`${data?.counters.offline ?? 0} offline · ${data?.counters.warning ?? 0} warning`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Fleet status</CardTitle>
            <CardDescription>Distribution of server states</CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <StatusDonutChart
                data={[
                  { status: 'ONLINE', count: data.statusSummary.online },
                  { status: 'WARNING', count: data.statusSummary.warning },
                  { status: 'OFFLINE', count: data.statusSummary.offline },
                  { status: 'DISABLED', count: data.statusSummary.disabled },
                ].filter((entry) => entry.count > 0)}
              />
            ) : (
              <Skeleton className="h-56" />
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Servers</CardTitle>
            <CardDescription>Live resource usage and heartbeat</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading && !data ? (
              Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-24" />)
            ) : error ? (
              <p className="py-8 text-center text-sm text-destructive">{error.message}</p>
            ) : (data?.servers.length ?? 0) === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No servers registered yet.
              </p>
            ) : (
              data?.servers.map((server) => (
                <div key={server.id} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/servers/${server.id}`} className="font-medium hover:underline">
                        {server.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {server.hostname}:{server.port}
                        {server.location ? ` · ${server.location}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={server.status} />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void refreshServer(server.id)}
                        loading={busyId === server.id}
                        aria-label={`Refresh ${server.name}`}
                      >
                        <RefreshCw />
                      </Button>
                    </div>
                  </div>

                  {server.lastError ? (
                    <p className="mt-2 truncate text-xs text-destructive" title={server.lastError}>
                      {server.lastError}
                    </p>
                  ) : null}

                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-1">
                      <p className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                        <Cpu className="size-3" /> CPU
                      </p>
                      <UsageBar percent={server.cpuPercent ?? 0} showLabel />
                    </div>
                    <div className="space-y-1">
                      <p className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                        <HardDrive className="size-3" /> RAM
                      </p>
                      <UsageBar percent={server.memPercent ?? 0} showLabel />
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Users / conns</p>
                      <p className="text-sm font-medium tabular-nums">
                        {server.activeUsers} / {server.activeConnections}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Bandwidth</p>
                      <p className="text-sm font-medium tabular-nums">
                        {formatBytes(server.totalBandwidthBytes)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 flex items-end gap-4">
                    <div className="flex-1">
                      {server.history.length > 1 ? (
                        <Sparkline data={server.history} dataKey="cpuPercent" height={36} />
                      ) : (
                        <p className="text-[11px] text-muted-foreground">No history yet</p>
                      )}
                    </div>
                    <p className="shrink-0 text-[11px] text-muted-foreground">
                      heartbeat {formatRelative(server.lastHeartbeat)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

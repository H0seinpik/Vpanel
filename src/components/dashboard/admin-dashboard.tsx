'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  Clock,
  Gauge,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  TrendingUp,
  Users,
} from 'lucide-react';
import { formatBytes, formatDateTime, formatRelative, textProgressBar } from '@/lib/format';
import { useApi } from '@/hooks/use-api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/common/stat-card';
import { PageHeader } from '@/components/common/page-header';
import { UsageBar } from '@/components/ui/primitives';
import {
  ActiveUsersChart,
  RankingBarChart,
  StatusDonutChart,
  TrafficAreaChart,
} from '@/components/charts';
import { useToast } from '@/components/ui/toast';

interface StatsResponse {
  stats: {
    totalUsers: number;
    activeUsers: number;
    expiredUsers: number;
    trafficExceededUsers: number;
    disabledUsers: number;
    totalServers: number;
    onlineServers: number;
    offlineServers: number;
    warningServers: number;
    totalConfigs: number;
    activeConfigs: number;
    totalTrafficUsedBytes: number;
    totalTrafficRemainingBytes: number;
    unlimitedUsers: number;
    activeSubscriptions: number;
  };
  recentActivity: Array<{
    id: string;
    action: string;
    actorName: string | null;
    targetType: string | null;
    createdAt: string;
  }>;
  generatedAt: string;
}

interface ChartsResponse {
  rangeDays: number;
  trafficOverTime: Array<{ bucket: string; uploadBytes: number; downloadBytes: number; totalBytes: number }>;
  activeUsersOverTime: Array<{ bucket: string; count: number }>;
  trafficByServer: Array<{ id: string; label: string; totalBytes: number }>;
  trafficByUser: Array<{ id: string; label: string; totalBytes: number }>;
  configStatus: Array<{ status: string; count: number }>;
  serverStatus: Array<{ status: string; count: number }>;
  trafficTotals: { uploadBytes: number; downloadBytes: number; totalBytes: number };
}

const RANGE_OPTIONS = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
];

/**
 * Admin dashboard.
 *
 * Both endpoints are polled, so counters and charts stay live without a page
 * reload. Everything shown here is aggregated server-side.
 */
export function AdminDashboard() {
  const toast = useToast();
  const [rangeDays, setRangeDays] = React.useState(30);
  const [refreshing, setRefreshing] = React.useState(false);

  const stats = useApi<StatsResponse>('/api/dashboard/stats', { refreshInterval: 30_000 });
  const charts = useApi<ChartsResponse>(`/api/dashboard/charts?days=${rangeDays}`, {
    refreshInterval: 60_000,
  });

  async function refreshAll() {
    setRefreshing(true);
    await Promise.all([stats.reload(), charts.reload()]);
    setRefreshing(false);
    toast.success('Dashboard refreshed');
  }

  if (stats.loading && !stats.data) {
    return (
      <div className="space-y-6">
        <PageHeader title="Dashboard" description="Fleet overview" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (stats.error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <AlertTriangle className="size-6 text-destructive" />
          <p className="text-sm font-medium">Could not load dashboard statistics</p>
          <p className="text-sm text-muted-foreground">{stats.error.message}</p>
          <Button onClick={() => void stats.reload()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const data = stats.data?.stats;
  if (!data) return null;

  const totalTraffic = data.totalTrafficUsedBytes + data.totalTrafficRemainingBytes;
  const usedPercent = totalTraffic > 0 ? (data.totalTrafficUsedBytes / totalTraffic) * 100 : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={`Updated ${formatRelative(stats.data?.generatedAt)}`}
        actions={
          <>
            <div className="inline-flex rounded-md border border-border bg-card p-0.5">
              {RANGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setRangeDays(option.value)}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    rangeDays === option.value
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={() => void refreshAll()} loading={refreshing}>
              <RefreshCw /> Refresh
            </Button>
            <Button size="sm" asChild>
              <Link href="/configs/new">
                <Plus /> New configuration
              </Link>
            </Button>
          </>
        }
      />

      {/* Top statistics */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Total users" value={data.totalUsers} icon={Users} hint={`${data.activeUsers} active`} />
        <StatCard label="Active users" value={data.activeUsers} icon={Activity} tone="success" hint={`${data.trafficExceededUsers} over quota`} />
        <StatCard label="Expired users" value={data.expiredUsers} icon={Clock} tone="warning" hint={`${data.disabledUsers} disabled`} />
        <StatCard label="Servers" value={data.totalServers} icon={Server} tone="accent" hint={`${data.onlineServers} online · ${data.offlineServers} offline`} />
        <StatCard label="Configurations" value={data.totalConfigs} icon={ShieldCheck} hint={`${data.activeConfigs} active`} />
        <StatCard label="Traffic used" value={formatBytes(data.totalTrafficUsedBytes)} icon={TrendingUp} tone="default" hint={textProgressBar(usedPercent)} />
        <StatCard label="Traffic remaining" value={formatBytes(data.totalTrafficRemainingBytes)} icon={Gauge} tone="success" hint={`${data.unlimitedUsers} unlimited accounts`} />
        <StatCard label="Online servers" value={data.onlineServers} icon={Server} tone="success" hint={`${data.warningServers} in warning state`} />
        <StatCard label="Offline servers" value={data.offlineServers} icon={AlertTriangle} tone={data.offlineServers > 0 ? 'destructive' : 'default'} />
        <StatCard label="Active subscriptions" value={data.activeSubscriptions} icon={ShieldCheck} tone="accent" />
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Traffic usage over time</CardTitle>
            <CardDescription>Upload and download volume, last {rangeDays} days</CardDescription>
          </CardHeader>
          <CardContent>
            {charts.data?.trafficOverTime.length ? (
              <TrafficAreaChart data={charts.data.trafficOverTime} />
            ) : (
              <p className="py-16 text-center text-sm text-muted-foreground">
                No traffic recorded in this period yet.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuration status</CardTitle>
            <CardDescription>Distribution across all configurations</CardDescription>
          </CardHeader>
          <CardContent>
            {charts.data?.configStatus.length ? (
              <StatusDonutChart data={charts.data.configStatus} />
            ) : (
              <p className="py-16 text-center text-sm text-muted-foreground">No configurations yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Active users over time</CardTitle>
            <CardDescription>Distinct accounts that moved traffic each day</CardDescription>
          </CardHeader>
          <CardContent>
            {charts.data?.activeUsersOverTime.length ? (
              <ActiveUsersChart data={charts.data.activeUsersOverTime} />
            ) : (
              <p className="py-16 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Traffic consumption by server</CardTitle>
            <CardDescription>Top nodes by transferred volume</CardDescription>
          </CardHeader>
          <CardContent>
            {charts.data?.trafficByServer.length ? (
              <RankingBarChart data={charts.data.trafficByServer} />
            ) : (
              <p className="py-16 text-center text-sm text-muted-foreground">No server traffic yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Traffic consumption by user</CardTitle>
            <CardDescription>Highest consumers in the period</CardDescription>
          </CardHeader>
          <CardContent>
            {charts.data?.trafficByUser.length ? (
              <RankingBarChart data={charts.data.trafficByUser} color="hsl(199 89% 48%)" />
            ) : (
              <p className="py-16 text-center text-sm text-muted-foreground">No user traffic yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Server status</CardTitle>
            <CardDescription>Live health across the fleet</CardDescription>
          </CardHeader>
          <CardContent>
            {charts.data?.serverStatus.length ? (
              <StatusDonutChart data={charts.data.serverStatus} />
            ) : (
              <p className="py-16 text-center text-sm text-muted-foreground">
                No servers registered yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Latest audited actions</CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/logs">View all</Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-1">
          {(stats.data?.recentActivity ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
          ) : (
            stats.data?.recentActivity.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/50"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StatusBadge status="INFO" label={entry.action} />
                  <span className="truncate text-muted-foreground">
                    {entry.actorName ?? 'system'}
                    {entry.targetType ? ` · ${entry.targetType}` : ''}
                  </span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDateTime(entry.createdAt)}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Capacity summary */}
      <Card>
        <CardHeader>
          <CardTitle>Capacity overview</CardTitle>
          <CardDescription>Aggregate allowance across all accounts</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total consumed</span>
            <span className="font-medium tabular-nums">
              {formatBytes(data.totalTrafficUsedBytes)} / {formatBytes(totalTraffic)}
            </span>
          </div>
          <UsageBar percent={usedPercent} showLabel />
        </CardContent>
      </Card>
    </div>
  );
}

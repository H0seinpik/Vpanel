'use client';

import * as React from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import { toQuery } from '@/lib/api-client';
import { useApi } from '@/hooks/use-api';
import { formatBytes, formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { StatCard } from '@/components/common/stat-card';
import { RankingBarChart, TrafficAreaChart } from '@/components/charts';

interface TrafficResponse {
  totals: { uploadBytes: number; downloadBytes: number; totalBytes: number; recordCount: number };
  series: Array<{ bucket: string; uploadBytes: number; downloadBytes: number; totalBytes: number }>;
  topUsers: Array<{ id: string; label: string; totalBytes: number }>;
  topServers: Array<{ id: string; label: string; totalBytes: number }>;
  recent: Array<{
    id: string;
    uploadBytes: number;
    downloadBytes: number;
    totalBytes: number;
    timestamp: string;
    source: string;
    user: { username: string; displayName: string | null } | null;
    server: { name: string } | null;
    config: { name: string } | null;
  }>;
}

const RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

/** Fleet-wide traffic accounting view. */
export default function TrafficPage() {
  const [days, setDays] = React.useState(30);
  const [granularity, setGranularity] = React.useState<'day' | 'hour' | 'month'>('day');
  const [serverId, setServerId] = React.useState('');

  const servers = useApi<{ data: Array<{ id: string; name: string }> }>('/api/servers?pageSize=100');

  // `from` MUST be stable across renders.
  //
  // Computing it inline (`new Date(Date.now() - days * 86_400_000)`) produced a
  // new query string on every render: the path changed, which re-triggered the
  // fetch, which re-rendered — an endless request loop that showed up as the
  // page "refreshing constantly".
  const from = React.useMemo(
    () => new Date(Date.now() - days * 86_400_000).toISOString(),
    [days],
  );
  const path = `/api/traffic${toQuery({ from, granularity, serverId })}`;
  const { data, loading, error, reload, refreshing } = useApi<TrafficResponse>(path, {
    refreshInterval: 60_000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Traffic"
        description="Consumption across the fleet. All figures are computed from the server-side ledger."
        actions={
          <>
            <div className="inline-flex rounded-md border border-border bg-card p-0.5">
              {RANGES.map((range) => (
                <button
                  key={range.days}
                  type="button"
                  onClick={() => setDays(range.days)}
                  className={`rounded px-2.5 py-1 text-xs font-medium ${
                    days === range.days ? 'bg-muted text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {range.label}
                </button>
              ))}
            </div>
            <select
              value={granularity}
              onChange={(event) => setGranularity(event.target.value as 'day' | 'hour' | 'month')}
              className="h-9 rounded-md border border-input bg-card px-2 text-sm"
              aria-label="Granularity"
            >
              <option value="hour">Hourly</option>
              <option value="day">Daily</option>
              <option value="month">Monthly</option>
            </select>
            <select
              value={serverId}
              onChange={(event) => setServerId(event.target.value)}
              className="h-9 max-w-[180px] rounded-md border border-input bg-card px-2 text-sm"
              aria-label="Server filter"
            >
              <option value="">All servers</option>
              {(servers.data?.data ?? []).map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={() => void reload()} loading={refreshing}>
              <RefreshCw /> Refresh
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total traffic" value={formatBytes(data?.totals.totalBytes)} icon={BarChart3} />
        <StatCard label="Download" value={formatBytes(data?.totals.downloadBytes)} tone="accent" />
        <StatCard label="Upload" value={formatBytes(data?.totals.uploadBytes)} tone="success" />
        <StatCard label="Ledger rows" value={data?.totals.recordCount ?? '—'} hint={`last ${days} days`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Usage over time</CardTitle>
          <CardDescription>
            {granularity === 'hour' ? 'Hourly' : granularity === 'month' ? 'Monthly' : 'Daily'} totals for the
            selected period
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <Skeleton className="h-64" />
          ) : error ? (
            <p className="py-16 text-center text-sm text-destructive">{error.message}</p>
          ) : (data?.series.length ?? 0) === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No traffic recorded for this period.
            </p>
          ) : (
            <TrafficAreaChart data={data?.series ?? []} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By server</CardTitle>
            <CardDescription>Top nodes by transferred volume</CardDescription>
          </CardHeader>
          <CardContent>
            {(data?.topServers.length ?? 0) === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">No server traffic yet.</p>
            ) : (
              <RankingBarChart data={data?.topServers ?? []} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By user</CardTitle>
            <CardDescription>Highest consumers in the period</CardDescription>
          </CardHeader>
          <CardContent>
            {(data?.topUsers.length ?? 0) === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">No user traffic yet.</p>
            ) : (
              <RankingBarChart data={data?.topUsers ?? []} color="hsl(199 89% 48%)" />
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Recent ledger entries</CardTitle>
          <CardDescription>Most recent collection windows</CardDescription>
        </CardHeader>
        {(data?.recent.length ?? 0) === 0 ? (
          <CardContent>
            <p className="py-8 text-center text-sm text-muted-foreground">No entries yet.</p>
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Server</TableHead>
                <TableHead>Configuration</TableHead>
                <TableHead>Upload</TableHead>
                <TableHead>Download</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.recent.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(row.timestamp)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.user?.displayName ?? row.user?.username ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.server?.name ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.config?.name ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">{formatBytes(row.uploadBytes)}</TableCell>
                  <TableCell className="text-sm tabular-nums">{formatBytes(row.downloadBytes)}</TableCell>
                  <TableCell className="text-sm font-medium tabular-nums">
                    {formatBytes(row.totalBytes)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status="INFO" label={row.source} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  MoreHorizontal,
  Plus,
  Power,
  RefreshCw,
  Server as ServerIcon,
  Trash2,
  Zap,
} from 'lucide-react';
import { api, ApiError, toQuery } from '@/lib/api-client';
import { useApi, useDebounced } from '@/hooks/use-api';
import { formatBytes, formatRelative } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Skeleton, EmptyState } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { StatCard } from '@/components/common/stat-card';
import { DataToolbar } from '@/components/common/data-toolbar';
import { Pagination, type PaginationMeta } from '@/components/common/pagination';
import { UsageBar } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

interface ServerRow {
  id: string;
  name: string;
  hostname: string;
  ipAddress: string;
  port: number;
  protocol: string;
  type: string;
  location: string | null;
  status: string;
  cpuPercent: number | null;
  memPercent: number | null;
  activeUsers: number;
  activeConnections: number;
  totalBandwidthBytes: number;
  lastHeartbeat: string | null;
  lastError: string | null;
  hasAgent: boolean;
}

interface ServersResponse {
  data: ServerRow[];
  pagination: PaginationMeta;
  counters: { total: number; online: number; offline: number; warning: number; disabled: number };
}

/**
 * Servers list.
 *
 * Supports search, status/type filters, pagination and per-row actions
 * (test connection, refresh status, enable/disable, delete). Destructive
 * actions always go through a confirmation dialog.
 */
export default function ServersPage() {
  const toast = useToast();

  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [type, setType] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const debouncedSearch = useDebounced(search);

  const path = `/api/servers${toQuery({
    search: debouncedSearch,
    status,
    type,
    page,
    pageSize,
  })}`;

  const { data, loading, error, reload, refreshing } = useApi<ServersResponse>(path, {
    refreshInterval: 30_000,
  });

  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<ServerRow | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, type]);

  async function runAction(
    server: ServerRow,
    action: 'test' | 'refresh' | 'toggle',
    successMessage: string,
  ) {
    setBusyId(server.id);
    try {
      if (action === 'test') {
        const result = await api.post<{ ok: boolean; message: string; latencyMs?: number }>(
          `/api/servers/${server.id}/test`,
        );
        if (result.ok) {
          toast.success('Connection OK', `${result.message}${result.latencyMs ? ` (${result.latencyMs} ms)` : ''}`);
        } else {
          toast.warning('Connection failed', result.message);
        }
      } else if (action === 'refresh') {
        await api.post(`/api/servers/${server.id}/refresh`);
        toast.success(successMessage);
      } else {
        const nextStatus = server.status === 'DISABLED' ? 'ONLINE' : 'DISABLED';
        await api.patch(`/api/servers/${server.id}`, { status: nextStatus });
        toast.success(nextStatus === 'DISABLED' ? 'Server disabled' : 'Server enabled');
      }
      await reload();
    } catch (caught) {
      toast.error(
        'Action failed',
        caught instanceof ApiError ? caught.message : 'Unexpected error',
      );
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.delete(`/api/servers/${pendingDelete.id}`);
      toast.success('Server deleted', `"${pendingDelete.name}" and its configurations were removed.`);
      setPendingDelete(null);
      await reload();
    } catch (caught) {
      toast.error('Delete failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setDeleting(false);
    }
  }

  const counters = data?.counters;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Servers"
        description="Nodes you have registered for monitoring and configuration."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void reload()} loading={refreshing}>
              <RefreshCw /> Refresh
            </Button>
            <Button size="sm" asChild>
              <Link href="/servers/new">
                <Plus /> Add server
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total servers" value={counters?.total ?? '—'} icon={ServerIcon} />
        <StatCard label="Online" value={counters?.online ?? '—'} icon={Activity} tone="success" />
        <StatCard
          label="Offline"
          value={counters?.offline ?? '—'}
          icon={AlertTriangle}
          tone={counters && counters.offline > 0 ? 'destructive' : 'default'}
        />
        <StatCard label="Warning" value={counters?.warning ?? '—'} icon={Zap} tone="warning" />
      </div>

      <Card className="overflow-hidden">
        <DataToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search name, host or location…"
          filters={[
            {
              key: 'status',
              label: 'Status',
              value: status,
              options: ['ONLINE', 'OFFLINE', 'WARNING', 'DISABLED', 'PENDING'].map((value) => ({
                label: value,
                value,
              })),
            },
            {
              key: 'type',
              label: 'Type',
              value: type,
              options: ['XRAY', 'V2RAY', 'GENERIC'].map((value) => ({ label: value, value })),
            },
          ]}
          onFilterChange={(key, value) => (key === 'status' ? setStatus(value) : setType(value))}
        />

        {loading && !data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </div>
        ) : error ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium">Could not load servers</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        ) : (data?.data.length ?? 0) === 0 ? (
          <EmptyState
            icon={ServerIcon}
            title="No servers found"
            description={
              search || status || type
                ? 'Try adjusting your search or filters.'
                : 'Register your first node to start generating configurations.'
            }
            action={
              !search && !status && !type ? (
                <Button size="sm" asChild>
                  <Link href="/servers/new">
                    <Plus /> Add server
                  </Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Server</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[140px]">CPU / RAM</TableHead>
                  <TableHead>Active users</TableHead>
                  <TableHead>Bandwidth</TableHead>
                  <TableHead>Last heartbeat</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.data.map((server) => (
                  <TableRow key={server.id}>
                    <TableCell>
                      <Link href={`/servers/${server.id}`} className="block">
                        <p className="font-medium hover:underline">{server.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {server.hostname}:{server.port} · {server.type}
                        </p>
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {server.location ?? '—'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={server.status} />
                      {server.lastError ? (
                        <p className="mt-1 max-w-[180px] truncate text-[11px] text-destructive" title={server.lastError}>
                          {server.lastError}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span className="w-8 text-[11px] text-muted-foreground">CPU</span>
                          <UsageBar percent={server.cpuPercent ?? 0} className="w-20" />
                          <span className="w-8 text-[11px] tabular-nums">
                            {server.cpuPercent !== null ? `${Math.round(server.cpuPercent)}%` : '—'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-8 text-[11px] text-muted-foreground">RAM</span>
                          <UsageBar percent={server.memPercent ?? 0} className="w-20" />
                          <span className="w-8 text-[11px] tabular-nums">
                            {server.memPercent !== null ? `${Math.round(server.memPercent)}%` : '—'}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {server.activeUsers}
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({server.activeConnections} conn)
                      </span>
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {formatBytes(server.totalBandwidthBytes)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(server.lastHeartbeat)}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busyId === server.id}
                            aria-label={`Actions for ${server.name}`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/servers/${server.id}`}>View details</Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void runAction(server, 'test', 'Connection tested')}>
                            <Zap /> Test connection
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void runAction(server, 'refresh', 'Status refreshed')}>
                            <RefreshCw /> Refresh status
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => void runAction(server, 'toggle', 'Server updated')}>
                            <Power /> {server.status === 'DISABLED' ? 'Enable server' : 'Disable server'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => setPendingDelete(server)}
                          >
                            <Trash2 /> Delete server
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {data ? (
              <Pagination
                meta={data.pagination}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            ) : null}
          </>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete "${pendingDelete?.name}"?`}
        description="This permanently removes the server together with all of its configurations and assignments. Traffic history is retained. This cannot be undone."
        confirmLabel="Delete server"
        destructive
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

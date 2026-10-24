'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  MoreHorizontal,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { api, ApiError, toQuery } from '@/lib/api-client';
import { useApi, useDebounced } from '@/hooks/use-api';
import { formatAllowance, formatBytes, formatDate, formatRemaining, remainingBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { ConfigActions } from '@/components/configs/config-actions';
import { useToast } from '@/components/ui/toast';

interface ConfigRow {
  id: string;
  name: string;
  type: string;
  status: string;
  assignmentCount?: number;
  /** The configuration's own ceiling (null = unlimited). */
  trafficLimitBytes: number | null;
  /** Total across every assignment, computed server-side. */
  trafficUsedBytes: number;
  /** Protocol parameters; the port decides whether two configs can coexist. */
  params: Record<string, unknown>;
  owner: { username: string; displayName: string | null } | null;
  server?: { id: string; name: string; location: string | null };
  createdAt: string;
}

/** Percentage of the configuration's own allowance that has been consumed. */
function usagePercent(used: number, limit: number | null): number {
  if (limit === null || limit <= 0) return 0;
  return Math.min(100, (used / limit) * 100);
}

/** True when 90%+ of the allowance is gone, so the remaining figure warns. */
function isLowRemaining(used: number, limit: number | null): boolean {
  const remaining = remainingBytes(used, limit);
  if (remaining === null || limit === null || limit <= 0) return false;
  return remaining <= limit * 0.1;
}

interface ConfigsResponse {
  data: ConfigRow[];
  pagination: PaginationMeta;
}

/** Configurations list with filters, delivery actions and lifecycle controls. */
export default function ConfigsPage() {
  const toast = useToast();

  const [search, setSearch] = React.useState('');
  const [protocol, setProtocol] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [serverId, setServerId] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const debouncedSearch = useDebounced(search);
  const path = `/api/configs${toQuery({
    search: debouncedSearch,
    protocol,
    status,
    serverId,
    page,
    pageSize,
  })}`;

  const { data, loading, error, reload, refreshing } = useApi<ConfigsResponse>(path);
  const servers = useApi<{ data: Array<{ id: string; name: string }> }>('/api/servers?pageSize=100');

  const [deleteTarget, setDeleteTarget] = React.useState<ConfigRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, protocol, status, serverId]);

  async function toggleStatus(config: ConfigRow) {
    const next = config.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
    try {
      await api.patch(`/api/configs/${config.id}`, { status: next });
      toast.success(next === 'DISABLED' ? 'Configuration disabled' : 'Configuration enabled');
      await reload();
    } catch (caught) {
      toast.error('Update failed', caught instanceof ApiError ? caught.message : undefined);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/api/configs/${deleteTarget.id}`);
      toast.success('Configuration deleted');
      setDeleteTarget(null);
      await reload();
    } catch (caught) {
      toast.error('Delete failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setDeleteBusy(false);
    }
  }

  const rows = data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Configurations"
        description="Generated client configurations and their assignments."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void reload()} loading={refreshing}>
              <RefreshCw /> Refresh
            </Button>
            <Button size="sm" asChild>
              <Link href="/configs/new">
                <Plus /> Create configuration
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total" value={data?.pagination.total ?? '—'} icon={ShieldCheck} />
        <StatCard label="Active (page)" value={rows.filter((row) => row.status === 'ACTIVE').length} tone="success" icon={ShieldCheck} />
        <StatCard label="Disabled (page)" value={rows.filter((row) => row.status === 'DISABLED').length} tone="warning" icon={ShieldCheck} />
        <StatCard label="Expired (page)" value={rows.filter((row) => row.status === 'EXPIRED').length} tone="destructive" icon={ShieldCheck} />
      </div>

      <Card className="overflow-hidden">
        <DataToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search configuration name…"
          filters={[
            {
              key: 'protocol',
              label: 'Protocol',
              value: protocol,
              options: ['VLESS', 'VMESS', 'TROJAN', 'SHADOWSOCKS'].map((value) => ({ label: value, value })),
            },
            {
              key: 'status',
              label: 'Status',
              value: status,
              options: ['ACTIVE', 'DISABLED', 'EXPIRED'].map((value) => ({ label: value, value })),
            },
            {
              key: 'serverId',
              label: 'Server',
              value: serverId,
              options: (servers.data?.data ?? []).map((server) => ({ label: server.name, value: server.id })),
            },
          ]}
          onFilterChange={(key, value) => {
            if (key === 'protocol') setProtocol(value);
            else if (key === 'status') setStatus(value);
            else setServerId(value);
          }}
        />

        {loading && !data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </div>
        ) : error ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium">Could not load configurations</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No configurations found"
            description="Use the wizard to generate your first configuration."
            action={
              <Button size="sm" asChild>
                <Link href="/configs/new">
                  <Plus /> Create configuration
                </Link>
              </Button>
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Configuration</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Users</TableHead>
                  <TableHead className="w-[190px]">Traffic</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[140px]">Delivery</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((config) => (
                  <TableRow key={config.id}>
                    <TableCell>
                      <Link href={`/configs/${config.id}`} className="font-medium hover:underline">
                        {config.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {config.server?.name ?? '—'}
                      {config.server?.location ? ` · ${config.server.location}` : ''}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status="INFO" label={config.type} />
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {String(config.params?.port ?? '—')}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {config.owner?.displayName ?? config.owner?.username ?? '—'}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">{config.assignmentCount ?? 0}</TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <UsageBar percent={usagePercent(config.trafficUsedBytes, config.trafficLimitBytes)} />
                        <p className="text-[11px] tabular-nums text-muted-foreground">
                          {formatBytes(config.trafficUsedBytes)} / {formatAllowance(config.trafficLimitBytes)}
                        </p>
                        <p
                          className={cn(
                            'text-[11px] font-medium tabular-nums',
                            isLowRemaining(config.trafficUsedBytes, config.trafficLimitBytes)
                              ? 'text-destructive'
                              : 'text-emerald-500',
                          )}
                        >
                          {formatRemaining(config.trafficUsedBytes, config.trafficLimitBytes)}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={config.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(config.createdAt)}
                    </TableCell>
                    <TableCell>
                      <ConfigActions
                        configId={config.id}
                        name={config.name}
                        protocol={config.type}
                        compact
                      />
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${config.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/configs/${config.id}`}>View details</Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void toggleStatus(config)}>
                            <Power /> {config.status === 'DISABLED' ? 'Enable' : 'Disable'}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => setDeleteTarget(config)}
                          >
                            <Trash2 /> Delete
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
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete "${deleteTarget?.name}"?`}
        description="Every assigned user loses access to this configuration immediately. This cannot be undone."
        confirmLabel="Delete configuration"
        destructive
        loading={deleteBusy}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

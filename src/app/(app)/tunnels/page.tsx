'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Activity,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
  Waypoints,
} from 'lucide-react';
import { api, ApiError, copyToClipboard, toQuery } from '@/lib/api-client';
import { useApi, useDebounced } from '@/hooks/use-api';
import { formatBytes } from '@/lib/format';
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
import { EmptyState, Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { StatCard } from '@/components/common/stat-card';
import { DataToolbar } from '@/components/common/data-toolbar';
import { Pagination, type PaginationMeta } from '@/components/common/pagination';
import { useToast } from '@/components/ui/toast';
import { TunnelFormDialog } from '@/components/tunnels/tunnel-form-dialog';
import type {
  TunnelCounters,
  TunnelNetwork,
  TunnelRow,
  TunnelRuntime,
  TunnelServer,
} from '@/components/tunnels/types';

interface TunnelsResponse {
  data: TunnelRow[];
  pagination: PaginationMeta;
  counters?: TunnelCounters;
  runtime?: TunnelRuntime;
}

const NETWORK_LABEL: Record<TunnelNetwork, string> = {
  TCP: 'TCP',
  UDP: 'UDP',
  TCP_UDP: 'TCP + UDP',
};

function describeError(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : 'Something went wrong';
}

/**
 * Status combines the operator's intent (`enabled`) with what the supervisor
 * actually applied. "Enabled" alone is misleading right after a save: the row is
 * enabled but Xray has not restarted yet.
 */
function statusFor(tunnel: TunnelRow, runtime?: TunnelRuntime) {
  if (!tunnel.enabled) return { status: 'DISABLED', label: 'Disabled' };
  if (tunnel.lastError) return { status: 'WARNING', label: 'Needs attention' };
  if (!runtime) return { status: 'PENDING', label: 'Pending' };
  if (!runtime.enabled) return { status: 'PENDING', label: 'Xray disabled' };
  if (!runtime.running) return { status: 'PENDING', label: 'Xray stopped' };
  if (runtime.appliedPorts.includes(tunnel.listenPort)) {
    return { status: 'ACTIVE', label: 'Active' };
  }
  return { status: 'PENDING', label: 'Pending sync' };
}

export default function TunnelsPage() {
  const { success, error: toastError } = useToast();

  const [search, setSearch] = React.useState('');
  const debouncedSearch = useDebounced(search);
  const [serverId, setServerId] = React.useState('');
  const [network, setNetwork] = React.useState('');
  const [enabledFilter, setEnabledFilter] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TunnelRow | null>(null);
  const [deleting, setDeleting] = React.useState<TunnelRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const path = React.useMemo(
    () =>
      `/api/tunnels${toQuery({
        search: debouncedSearch,
        serverId,
        network,
        enabled: enabledFilter,
        page,
        pageSize,
      })}`,
    [debouncedSearch, serverId, network, enabledFilter, page, pageSize],
  );

  const { data, error, loading, refreshing, reload } = useApi<TunnelsResponse>(path, {
    refreshInterval: 15_000,
    revalidateOnFocus: true,
  });

  const { data: serversData } = useApi<{ data: TunnelServer[] }>('/api/servers?pageSize=200');
  const servers = serversData?.data ?? [];

  const rows = data?.data ?? [];
  const pagination = data?.pagination;
  const counters = data?.counters;
  const runtime = data?.runtime;
  const hasFilters = Boolean(debouncedSearch || serverId || network || enabledFilter);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(tunnel: TunnelRow) {
    setEditing(tunnel);
    setDialogOpen(true);
  }

  function changeFilter(key: string, value: string) {
    if (key === 'serverId') setServerId(value);
    if (key === 'network') setNetwork(value);
    if (key === 'enabled') setEnabledFilter(value);
    setPage(1);
  }

  function clearFilters() {
    setSearch('');
    setServerId('');
    setNetwork('');
    setEnabledFilter('');
    setPage(1);
  }

  async function toggleTunnel(tunnel: TunnelRow) {
    setBusyId(tunnel.id);
    try {
      await api.patch(`/api/tunnels/${tunnel.id}`, { enabled: !tunnel.enabled });
      success(
        tunnel.enabled ? 'Tunnel disabled' : 'Tunnel enabled',
        tunnel.enabled
          ? 'Traffic stops on the next reconcile.'
          : 'Traffic starts on the next reconcile.',
      );
      await reload();
    } catch (caught) {
      toastError('Could not change tunnel state', describeError(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function copyAddress(tunnel: TunnelRow) {
    const host = tunnel.server?.hostname || tunnel.listenAddress;
    const address = `${host}:${tunnel.listenPort}`;
    const copied = await copyToClipboard(address);
    if (copied) success('Address copied', address);
    else toastError('Could not copy address', address);
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/api/tunnels/${deleting.id}`);
      success('Tunnel deleted', `${deleting.name} will stop forwarding on the next reconcile.`);
      setDeleting(null);
      await reload();
    } catch (caught) {
      toastError('Could not delete tunnel', describeError(caught));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tunnels"
        description="Credential-less port forwarding. A tunnel has no users, passwords or share links — it simply forwards a port to another host."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void reload()}
              disabled={refreshing}
            >
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
              Refresh
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" />
              New tunnel
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Tunnels"
          value={counters?.total ?? pagination?.total ?? 0}
          hint="Configured on this panel"
          icon={Waypoints}
        />
        <StatCard
          label="Enabled"
          value={counters?.enabled ?? rows.filter((row) => row.enabled).length}
          hint="Should be forwarded"
          icon={Power}
          tone="success"
        />
        <StatCard
          label="Disabled"
          value={counters?.disabled ?? rows.filter((row) => !row.enabled).length}
          hint="Saved but not serving"
          icon={PowerOff}
          tone="warning"
        />
        <StatCard
          label="Tunnel traffic"
          value={formatBytes(counters?.trafficTotalBytes ?? 0)}
          hint="Cumulative, measured by Xray"
          icon={Activity}
          tone="accent"
        />
      </div>

      {runtime && (!runtime.enabled || !runtime.running) ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          <strong className="font-medium">Xray is not serving right now.</strong>{' '}
          {runtime.enabled
            ? 'The node process is stopped, so enabled tunnels are saved but not forwarded.'
            : 'Xray is disabled in the panel settings. Tunnels will start once it is enabled.'}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <DataToolbar
          search={search}
          onSearchChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          searchPlaceholder="Search tunnels…"
          filters={[
            {
              key: 'serverId',
              label: 'Server',
              value: serverId,
              options: servers.map((server) => ({ label: server.name, value: server.id })),
              allLabel: 'All servers',
            },
            {
              key: 'network',
              label: 'Transport',
              value: network,
              options: [
                { label: 'TCP', value: 'TCP' },
                { label: 'UDP', value: 'UDP' },
                { label: 'TCP + UDP', value: 'TCP_UDP' },
              ],
              allLabel: 'All transports',
            },
            {
              key: 'enabled',
              label: 'State',
              value: enabledFilter,
              options: [
                { label: 'Enabled', value: 'true' },
                { label: 'Disabled', value: 'false' },
              ],
              allLabel: 'All states',
            },
          ]}
          onFilterChange={changeFilter}
          actions={
            <span className="text-xs text-muted-foreground">
              {pagination?.total ?? rows.length} total
            </span>
          }
        />

        {loading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </div>
        ) : error ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium">Could not load tunnels</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Waypoints}
              title={hasFilters ? 'No tunnels match these filters' : 'No tunnels yet'}
              description={
                hasFilters
                  ? 'Try a different search or clear the filters.'
                  : 'Create a tunnel to forward a public port on this node to another host.'
              }
              action={
                hasFilters ? (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : (
                  <Button size="sm" onClick={openCreate}>
                    <Plus className="size-4" />
                    New tunnel
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tunnel</TableHead>
                  <TableHead>Listen</TableHead>
                  <TableHead className="hidden md:table-cell">Destination</TableHead>
                  <TableHead className="hidden sm:table-cell">Transport</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Traffic</TableHead>
                  <TableHead className="w-12 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((tunnel) => {
                  const status = statusFor(tunnel, runtime);
                  return (
                    <TableRow key={tunnel.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <Waypoints className="size-4" />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium">{tunnel.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {tunnel.server?.name ?? 'Unknown server'}
                              {tunnel.notes ? ` · ${tunnel.notes}` : ''}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {tunnel.listenAddress}:{tunnel.listenPort}
                        </code>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {tunnel.targetHost}:{tunnel.targetPort}
                        </code>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {NETWORK_LABEL[tunnel.network]}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <StatusBadge status={status.status} label={status.label} />
                          {tunnel.lastError ? (
                            <p className="max-w-[220px] truncate text-xs text-warning" title={tunnel.lastError}>
                              {tunnel.lastError}
                            </p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <p className="text-sm tabular-nums">
                          {formatBytes(tunnel.trafficTotalBytes)}
                        </p>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          ↑ {formatBytes(tunnel.trafficUpBytes)} · ↓ {formatBytes(tunnel.trafficDownBytes)}
                        </p>
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label={`Actions for ${tunnel.name}`}
                              disabled={busyId === tunnel.id}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem onSelect={() => openEdit(tunnel)}>
                              <Pencil className="mr-2 size-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void copyAddress(tunnel)}>
                              <Copy className="mr-2 size-4" />
                              Copy address
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => void toggleTunnel(tunnel)}
                              disabled={busyId === tunnel.id}
                            >
                              {tunnel.enabled ? (
                                <PowerOff className="mr-2 size-4" />
                              ) : (
                                <Power className="mr-2 size-4" />
                              )}
                              {tunnel.enabled ? 'Disable' : 'Enable'}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => setDeleting(tunnel)}
                            >
                              <Trash2 className="mr-2 size-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {pagination ? (
              <Pagination
                meta={pagination}
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

      <p className="text-xs text-muted-foreground">
        Tunnels are rendered into the same Xray config as configurations. Saving a change can
        briefly restart Xray, and a new listen port may need a firewall rule. See{' '}
        <Link href="/settings" className="underline underline-offset-4 hover:text-foreground">
          Settings
        </Link>{' '}
        for node controls.
      </p>

      <TunnelFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        tunnel={editing}
        servers={servers}
        onSaved={() => reload()}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleting(null);
        }}
        title="Delete tunnel?"
        description={
          deleting
            ? `“${deleting.name}” will stop forwarding and its port will be released on the next reconcile. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete tunnel"
        destructive
        loading={deleteBusy}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

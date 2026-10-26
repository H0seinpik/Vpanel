'use client';

import * as React from 'react';
import { LogIn, MoreHorizontal, Pencil, Plus, Power, PowerOff, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, toQuery } from '@/lib/api-client';
import { useApi, useDebounced } from '@/hooks/use-api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
import { AdvancedFormDialog, type FieldSpec } from '@/components/advanced/advanced-form-dialog';

interface InboundRow {
  id: string;
  name: string;
  tag: string;
  protocol: string;
  listen: string;
  port: number;
  settings: Record<string, unknown>;
  streamSettings: Record<string, unknown>;
  sniffing: Record<string, unknown>;
  enabled: boolean;
  sortOrder: number;
  remarks: string | null;
  server?: { id: string; name: string; hostname: string; status: string };
}

interface InboundsResponse {
  data: InboundRow[];
  pagination: PaginationMeta;
}

const PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks', 'socks', 'http', 'tunnel', 'wireguard'];

function fieldsFor(servers: Array<{ id: string; name: string }>): FieldSpec[] {
  return [
    { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Portal (Iran)' },
    {
      name: 'serverId',
      label: 'Server',
      type: 'select',
      required: true,
      options: servers.map((server) => ({ label: server.name, value: server.id })),
    },
    {
      name: 'tag',
      label: 'Tag',
      type: 'text',
      required: true,
      placeholder: 'portal-in',
      help: 'Unique per server — Xray refuses to start on a duplicate tag.',
    },
    {
      name: 'protocol',
      label: 'Protocol',
      type: 'select',
      options: PROTOCOLS.map((value) => ({ label: value, value })),
    },
    { name: 'listen', label: 'Listen address', type: 'text', placeholder: '0.0.0.0' },
    { name: 'port', label: 'Port', type: 'number', required: true, placeholder: '443' },
    {
      name: 'settings',
      label: 'settings (JSON)',
      type: 'json',
      span: 2,
      rows: 6,
      placeholder: '{ "clients": [] }',
      help: 'Raw Xray inbound settings. Validated with "xray run -test" before it goes live.',
    },
    { name: 'streamSettings', label: 'streamSettings (JSON)', type: 'json', span: 2, rows: 4 },
    { name: 'sniffing', label: 'sniffing (JSON)', type: 'json', span: 2, rows: 3 },
    { name: 'sortOrder', label: 'Order', type: 'number' },
    { name: 'enabled', label: 'Enabled', type: 'switch' },
    { name: 'remarks', label: 'Notes', type: 'text', span: 2 },
  ];
}

function describeError(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : 'Something went wrong';
}

export default function InboundsPage() {
  const { success, error: toastError } = useToast();

  const [search, setSearch] = React.useState('');
  const debouncedSearch = useDebounced(search);
  const [serverId, setServerId] = React.useState('');
  const [enabledFilter, setEnabledFilter] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<InboundRow | null>(null);
  const [deleting, setDeleting] = React.useState<InboundRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const path = React.useMemo(
    () =>
      `/api/inbounds${toQuery({
        search: debouncedSearch,
        serverId,
        enabled: enabledFilter,
        page,
        pageSize,
      })}`,
    [debouncedSearch, serverId, enabledFilter, page, pageSize],
  );

  const { data, error, loading, refreshing, reload } = useApi<InboundsResponse>(path);
  const { data: serversData } = useApi<{ data: Array<{ id: string; name: string }> }>(
    '/api/servers?pageSize=200',
  );
  const servers = serversData?.data ?? [];

  const rows = data?.data ?? [];
  const pagination = data?.pagination;
  const hasFilters = Boolean(debouncedSearch || serverId || enabledFilter);

  async function save(payload: Record<string, unknown>) {
    if (editing) {
      await api.patch(`/api/inbounds/${editing.id}`, payload);
      success('Inbound updated', 'The node picks it up on the next reconcile.');
    } else {
      await api.post('/api/inbounds', payload);
      success('Inbound created', 'The node picks it up on the next reconcile.');
    }
    await reload();
  }

  async function toggle(row: InboundRow) {
    setBusyId(row.id);
    try {
      await api.patch(`/api/inbounds/${row.id}`, { enabled: !row.enabled });
      success(row.enabled ? 'Inbound disabled' : 'Inbound enabled');
      await reload();
    } catch (caught) {
      toastError('Could not change state', describeError(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/api/inbounds/${deleting.id}`);
      success('Inbound deleted', `${deleting.name} is removed on the next reconcile.`);
      setDeleting(null);
      await reload();
    } catch (caught) {
      toastError('Could not delete inbound', describeError(caught));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inbounds"
        description="Raw Xray inbounds managed by hand — the pieces the wizard does not generate (a reverse-proxy portal, a custom listener)."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void reload()} disabled={refreshing}>
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="size-4" />
              New inbound
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Inbounds" value={pagination?.total ?? rows.length} icon={LogIn} hint="On this node" />
        <StatCard
          label="Enabled"
          value={rows.filter((row) => row.enabled).length}
          icon={Power}
          tone="success"
          hint="This page"
        />
        <StatCard
          label="Disabled"
          value={rows.filter((row) => !row.enabled).length}
          icon={PowerOff}
          tone="warning"
          hint="This page"
        />
      </div>

      <Card className="overflow-hidden">
        <DataToolbar
          search={search}
          onSearchChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          searchPlaceholder="Search inbounds…"
          filters={[
            {
              key: 'serverId',
              label: 'Server',
              value: serverId,
              options: servers.map((server) => ({ label: server.name, value: server.id })),
              allLabel: 'All servers',
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
          onFilterChange={(key, value) => {
            if (key === 'serverId') setServerId(value);
            if (key === 'enabled') setEnabledFilter(value);
            setPage(1);
          }}
          actions={
            <span className="text-xs text-muted-foreground">{pagination?.total ?? rows.length} total</span>
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
            <p className="text-sm font-medium">Could not load inbounds</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={LogIn}
              title={hasFilters ? 'No inbounds match these filters' : 'No custom inbounds yet'}
              description={
                hasFilters
                  ? 'Try a different search or clear the filters.'
                  : 'Add a raw Xray inbound when the wizard cannot express what you need.'
              }
              action={
                hasFilters ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSearch('');
                      setServerId('');
                      setEnabledFilter('');
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setDialogOpen(true)}>
                    <Plus className="size-4" />
                    New inbound
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
                  <TableHead>Inbound</TableHead>
                  <TableHead className="hidden md:table-cell">Server</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Listen</TableHead>
                  <TableHead className="hidden lg:table-cell">Order</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-12 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <LogIn className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{row.name}</p>
                          <code className="text-xs text-muted-foreground">{row.tag}</code>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                      {row.server?.name ?? '—'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status="INFO" label={row.protocol} />
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {row.listen}:{row.port}
                      </code>
                    </TableCell>
                    <TableCell className="hidden text-sm tabular-nums text-muted-foreground lg:table-cell">
                      {row.sortOrder}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={row.enabled ? 'ACTIVE' : 'DISABLED'}
                        label={row.enabled ? 'Enabled' : 'Disabled'}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`Actions for ${row.name}`}
                            disabled={busyId === row.id}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem
                            onSelect={() => {
                              setEditing(row);
                              setDialogOpen(true);
                            }}
                          >
                            <Pencil className="mr-2 size-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void toggle(row)} disabled={busyId === row.id}>
                            {row.enabled ? (
                              <PowerOff className="mr-2 size-4" />
                            ) : (
                              <Power className="mr-2 size-4" />
                            )}
                            {row.enabled ? 'Disable' : 'Enable'}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => setDeleting(row)}
                          >
                            <Trash2 className="mr-2 size-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
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
        Inbounds are merged into the same <code>config.json</code> as your configurations. A tag or
        port that is already in use is skipped (and reported), never renamed — a duplicate would stop
        the whole node from starting.
      </p>

      <AdvancedFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        title={editing ? 'Edit inbound' : 'New inbound'}
        description="Raw Xray inbound. The settings sections are stored verbatim and merged into the node config."
        fields={fieldsFor(servers)}
        initial={editing}
        submitLabel={editing ? 'Save changes' : 'Create inbound'}
        onSubmit={save}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleting(null);
        }}
        title="Delete inbound?"
        description={
          deleting
            ? `“${deleting.name}” stops serving on the next reconcile and its port is released. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete inbound"
        destructive
        loading={deleteBusy}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

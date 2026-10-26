'use client';

import * as React from 'react';
import { LogOut, MoreHorizontal, Pencil, Plus, Power, PowerOff, RefreshCw, Trash2 } from 'lucide-react';
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

interface OutboundRow {
  id: string;
  name: string;
  tag: string;
  protocol: string;
  settings: Record<string, unknown>;
  streamSettings: Record<string, unknown>;
  sendThrough: string | null;
  enabled: boolean;
  sortOrder: number;
  remarks: string | null;
  server?: { id: string; name: string; hostname: string; status: string };
}

interface OutboundsResponse {
  data: OutboundRow[];
  pagination: PaginationMeta;
}

const PROTOCOLS = [
  'freedom',
  'blackhole',
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
  'socks',
  'http',
  'wireguard',
  'loopback',
  'dns',
];

function fieldsFor(servers: Array<{ id: string; name: string }>): FieldSpec[] {
  return [
    { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Foreign (bridge)' },
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
      placeholder: 'foreign',
      help: 'Unique per server. Routing rules point at this tag.',
    },
    {
      name: 'protocol',
      label: 'Protocol',
      type: 'select',
      options: PROTOCOLS.map((value) => ({ label: value, value })),
    },
    {
      name: 'settings',
      label: 'settings (JSON)',
      type: 'json',
      span: 2,
      rows: 6,
      placeholder: '{ "servers": [ … ] }',
      help: 'Raw Xray outbound settings. Validated with "xray run -test" before it goes live.',
    },
    { name: 'streamSettings', label: 'streamSettings (JSON)', type: 'json', span: 2, rows: 4 },
    { name: 'sendThrough', label: 'Send through', type: 'text', placeholder: '0.0.0.0' },
    { name: 'sortOrder', label: 'Order', type: 'number' },
    { name: 'enabled', label: 'Enabled', type: 'switch' },
    { name: 'remarks', label: 'Notes', type: 'text', span: 2 },
  ];
}

function describeError(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : 'Something went wrong';
}

export default function OutboundsPage() {
  const { success, error: toastError } = useToast();

  const [search, setSearch] = React.useState('');
  const debouncedSearch = useDebounced(search);
  const [serverId, setServerId] = React.useState('');
  const [enabledFilter, setEnabledFilter] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<OutboundRow | null>(null);
  const [deleting, setDeleting] = React.useState<OutboundRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const path = React.useMemo(
    () =>
      `/api/outbounds${toQuery({
        search: debouncedSearch,
        serverId,
        enabled: enabledFilter,
        page,
        pageSize,
      })}`,
    [debouncedSearch, serverId, enabledFilter, page, pageSize],
  );

  const { data, error, loading, refreshing, reload } = useApi<OutboundsResponse>(path);
  const { data: serversData } = useApi<{ data: Array<{ id: string; name: string }> }>(
    '/api/servers?pageSize=200',
  );
  const servers = serversData?.data ?? [];

  const rows = data?.data ?? [];
  const pagination = data?.pagination;
  const hasFilters = Boolean(debouncedSearch || serverId || enabledFilter);

  async function save(payload: Record<string, unknown>) {
    if (editing) {
      await api.patch(`/api/outbounds/${editing.id}`, payload);
      success('Outbound updated', 'The node picks it up on the next reconcile.');
    } else {
      await api.post('/api/outbounds', payload);
      success('Outbound created', 'The node picks it up on the next reconcile.');
    }
    await reload();
  }

  async function toggle(row: OutboundRow) {
    setBusyId(row.id);
    try {
      await api.patch(`/api/outbounds/${row.id}`, { enabled: !row.enabled });
      success(row.enabled ? 'Outbound disabled' : 'Outbound enabled');
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
      await api.delete(`/api/outbounds/${deleting.id}`);
      success('Outbound deleted', `${deleting.name} is removed on the next reconcile.`);
      setDeleting(null);
      await reload();
    } catch (caught) {
      toastError('Could not delete outbound', describeError(caught));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Outbounds"
        description="Raw Xray outbounds — the destinations routing rules can send traffic to (direct, blocked, a bridge to another node)."
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
              New outbound
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Outbounds" value={pagination?.total ?? rows.length} icon={LogOut} hint="On this node" />
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
          searchPlaceholder="Search outbounds…"
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
            <p className="text-sm font-medium">Could not load outbounds</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={LogOut}
              title={hasFilters ? 'No outbounds match these filters' : 'No custom outbounds yet'}
              description={
                hasFilters
                  ? 'Try a different search or clear the filters.'
                  : 'The node always has "direct" and "blocked". Add one when you need a second path.'
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
                    New outbound
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
                  <TableHead>Outbound</TableHead>
                  <TableHead className="hidden md:table-cell">Server</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead className="hidden lg:table-cell">Send through</TableHead>
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
                          <LogOut className="size-4" />
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
                    <TableCell className="hidden lg:table-cell">
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {row.sendThrough || 'default'}
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
        Custom outbounds are appended <strong>after</strong> the built-in <code>direct</code> and{' '}
        <code>blocked</code>, so <code>direct</code> stays Xray&apos;s default route. Routing rules
        select between them by tag.
      </p>

      <AdvancedFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        title={editing ? 'Edit outbound' : 'New outbound'}
        description="Raw Xray outbound. Routing rules reach it by its tag."
        fields={fieldsFor(servers)}
        initial={editing}
        submitLabel={editing ? 'Save changes' : 'Create outbound'}
        onSubmit={save}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleting(null);
        }}
        title="Delete outbound?"
        description={
          deleting
            ? `“${deleting.name}” is removed on the next reconcile. Any routing rule that points at its tag will stop matching.`
            : undefined
        }
        confirmLabel="Delete outbound"
        destructive
        loading={deleteBusy}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

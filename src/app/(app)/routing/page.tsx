'use client';

import * as React from 'react';
import { MoreHorizontal, Pencil, Plus, Power, PowerOff, RefreshCw, Route, Trash2 } from 'lucide-react';
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

interface RoutingRow {
  id: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
  outboundTag: string | null;
  balancerTag: string | null;
  inboundTags: string[];
  domain: string[];
  ip: string[];
  port: string | null;
  sourceIp: string[];
  sourcePort: string | null;
  protocol: string[];
  network: string | null;
  remarks: string | null;
  server?: { id: string; name: string; hostname: string; status: string };
}

interface RoutingResponse {
  data: RoutingRow[];
  pagination: PaginationMeta;
}

function fieldsFor(servers: Array<{ id: string; name: string }>): FieldSpec[] {
  return [
    { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Iran domains → direct' },
    {
      name: 'serverId',
      label: 'Server',
      type: 'select',
      required: true,
      options: servers.map((server) => ({ label: server.name, value: server.id })),
    },
    {
      name: 'outboundTag',
      label: 'Outbound tag',
      type: 'text',
      placeholder: 'foreign',
      help: 'Send matching traffic to this outbound. Needs one of outboundTag / balancerTag.',
    },
    { name: 'balancerTag', label: 'Balancer tag', type: 'text', placeholder: '(optional)' },
    {
      name: 'inboundTags',
      label: 'Inbound tags',
      type: 'lines',
      span: 2,
      rows: 2,
      help: 'One per line. Empty = every inbound.',
    },
    {
      name: 'domain',
      label: 'Domains',
      type: 'lines',
      span: 2,
      rows: 4,
      placeholder: 'geosite:ir\ndomain:example.com',
      help: 'One per line: full:, domain:, regexp:, geosite:, ext:…',
    },
    {
      name: 'ip',
      label: 'IPs',
      type: 'lines',
      span: 2,
      rows: 3,
      placeholder: 'geoip:ir\n10.0.0.0/8',
      help: 'One per line: IP, CIDR, geoip:xx, ext:file:tag',
    },
    { name: 'port', label: 'Port', type: 'text', placeholder: '443 or 1000-2000' },
    { name: 'sourceIp', label: 'Source IPs', type: 'lines', span: 2, rows: 2 },
    { name: 'sourcePort', label: 'Source port', type: 'text' },
    {
      name: 'protocol',
      label: 'Protocols',
      type: 'lines',
      span: 2,
      rows: 2,
      placeholder: 'http\ntls\nbittorrent',
      help: 'Sniffed protocol names, one per line.',
    },
    {
      name: 'network',
      label: 'Network',
      type: 'select',
      // Radix forbids an empty SelectItem value, so "no filter" is expressed by
      // leaving the select unset (the field is simply omitted from the payload).
      options: [
        { label: 'TCP', value: 'tcp' },
        { label: 'UDP', value: 'udp' },
        { label: 'TCP + UDP', value: 'tcp,udp' },
      ],
      help: 'Leave empty to match any transport.',
    },
    { name: 'sortOrder', label: 'Order', type: 'number', help: 'Lower runs first.' },
    { name: 'enabled', label: 'Enabled', type: 'switch' },
    { name: 'remarks', label: 'Notes', type: 'text', span: 2 },
  ];
}

function describeError(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : 'Something went wrong';
}

export default function RoutingPage() {
  const { success, error: toastError } = useToast();

  const [search, setSearch] = React.useState('');
  const debouncedSearch = useDebounced(search);
  const [serverId, setServerId] = React.useState('');
  const [enabledFilter, setEnabledFilter] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<RoutingRow | null>(null);
  const [deleting, setDeleting] = React.useState<RoutingRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const path = React.useMemo(
    () =>
      `/api/routing${toQuery({
        search: debouncedSearch,
        serverId,
        enabled: enabledFilter,
        page,
        pageSize,
      })}`,
    [debouncedSearch, serverId, enabledFilter, page, pageSize],
  );

  const { data, error, loading, refreshing, reload } = useApi<RoutingResponse>(path);
  const { data: serversData } = useApi<{ data: Array<{ id: string; name: string }> }>(
    '/api/servers?pageSize=200',
  );
  const servers = serversData?.data ?? [];

  const rows = data?.data ?? [];
  const pagination = data?.pagination;
  const hasFilters = Boolean(debouncedSearch || serverId || enabledFilter);

  async function save(payload: Record<string, unknown>) {
    if (editing) {
      await api.patch(`/api/routing/${editing.id}`, payload);
      success('Routing rule updated', 'The node picks it up on the next reconcile.');
    } else {
      await api.post('/api/routing', payload);
      success('Routing rule created', 'The node picks it up on the next reconcile.');
    }
    await reload();
  }

  async function toggle(row: RoutingRow) {
    setBusyId(row.id);
    try {
      await api.patch(`/api/routing/${row.id}`, { enabled: !row.enabled });
      success(row.enabled ? 'Rule disabled' : 'Rule enabled');
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
      await api.delete(`/api/routing/${deleting.id}`);
      success('Routing rule deleted', `${deleting.name} is removed on the next reconcile.`);
      setDeleting(null);
      await reload();
    } catch (caught) {
      toastError('Could not delete rule', describeError(caught));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Routing"
        description="Xray routing rules. They run AFTER the panel's own rules (stats API, tunnels, private-IP block), so they can never break the panel itself."
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
              New rule
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Rules" value={pagination?.total ?? rows.length} icon={Route} hint="On this node" />
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
          searchPlaceholder="Search rules…"
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
            <p className="text-sm font-medium">Could not load routing rules</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Route}
              title={hasFilters ? 'No rules match these filters' : 'No routing rules yet'}
              description={
                hasFilters
                  ? 'Try a different search or clear the filters.'
                  : 'Without rules, all proxied traffic goes out through "direct".'
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
                    New rule
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
                  <TableHead>Rule</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead className="hidden md:table-cell">Match</TableHead>
                  <TableHead className="hidden lg:table-cell">Order</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-12 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const target = row.outboundTag ?? row.balancerTag ?? '—';
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <Route className="size-4" />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium">{row.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {row.server?.name ?? 'Unknown server'}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{target}</code>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {row.outboundTag ? 'outbound' : 'balancer'}
                        </p>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <p className="text-sm tabular-nums">
                          {row.domain.length} domains · {row.ip.length} IPs
                        </p>
                        <p className="text-xs text-muted-foreground">{row.network ?? 'any network'}</p>
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
                            <DropdownMenuItem
                              onSelect={() => void toggle(row)}
                              disabled={busyId === row.id}
                            >
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
        Rules run in <strong>Order</strong> (lower first) and are appended after the panel&apos;s
        infrastructure rules. Use them to send Iranian destinations to <code>direct</code> and
        everything else to your foreign outbound.
      </p>

      <AdvancedFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        title={editing ? 'Edit routing rule' : 'New routing rule'}
        description="A rule matches on any of its fields. List fields take one entry per line."
        fields={fieldsFor(servers)}
        initial={editing}
        submitLabel={editing ? 'Save changes' : 'Create rule'}
        onSubmit={save}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleting(null);
        }}
        title="Delete routing rule?"
        description={
          deleting
            ? `“${deleting.name}” is removed on the next reconcile. Matching traffic falls back to the default outbound.`
            : undefined
        }
        confirmLabel="Delete rule"
        destructive
        loading={deleteBusy}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

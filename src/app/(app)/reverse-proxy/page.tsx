'use client';

import * as React from 'react';
import {
  ArrowLeftRight,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
} from 'lucide-react';
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

interface ReverseRow {
  id: string;
  name: string;
  role: 'BRIDGE' | 'PORTAL';
  tag: string;
  domain: string;
  enabled: boolean;
  remarks: string | null;
  server?: { id: string; name: string; hostname: string; status: string };
}

interface ReverseResponse {
  data: ReverseRow[];
  pagination: PaginationMeta;
}

function fieldsFor(servers: Array<{ id: string; name: string }>): FieldSpec[] {
  return [
    { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Iran portal' },
    {
      name: 'serverId',
      label: 'Server',
      type: 'select',
      required: true,
      options: servers.map((server) => ({ label: server.name, value: server.id })),
    },
    {
      name: 'role',
      label: 'Role',
      type: 'select',
      required: true,
      options: [
        { label: 'PORTAL — listens on this node (Iran)', value: 'PORTAL' },
        { label: 'BRIDGE — dials the peer (Foreign)', value: 'BRIDGE' },
      ],
      help: 'The PORTAL runs where connectivity is needed; the BRIDGE runs where it exists.',
    },
    {
      name: 'tag',
      label: 'Tag',
      type: 'text',
      required: true,
      placeholder: 'portal',
      help: 'Unique per server.',
    },
    {
      name: 'domain',
      label: 'Peer domain',
      type: 'text',
      required: true,
      span: 2,
      placeholder: 'foreign.example.com',
      help: 'The opposite side of the tunnel that Xray dials.',
    },
    { name: 'enabled', label: 'Enabled', type: 'switch' },
    { name: 'remarks', label: 'Notes', type: 'text', span: 2 },
  ];
}

function describeError(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : 'Something went wrong';
}

export default function ReverseProxyPage() {
  const { success, error: toastError } = useToast();

  const [search, setSearch] = React.useState('');
  const debouncedSearch = useDebounced(search);
  const [serverId, setServerId] = React.useState('');
  const [roleFilter, setRoleFilter] = React.useState('');
  const [enabledFilter, setEnabledFilter] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ReverseRow | null>(null);
  const [deleting, setDeleting] = React.useState<ReverseRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const path = React.useMemo(
    () =>
      `/api/reverse-proxy${toQuery({
        search: debouncedSearch,
        serverId,
        role: roleFilter,
        enabled: enabledFilter,
        page,
        pageSize,
      })}`,
    [debouncedSearch, serverId, roleFilter, enabledFilter, page, pageSize],
  );

  const { data, error, loading, refreshing, reload } = useApi<ReverseResponse>(path);
  const { data: serversData } = useApi<{ data: Array<{ id: string; name: string }> }>(
    '/api/servers?pageSize=200',
  );
  const servers = serversData?.data ?? [];

  const rows = data?.data ?? [];
  const pagination = data?.pagination;
  const hasFilters = Boolean(debouncedSearch || serverId || roleFilter || enabledFilter);

  async function save(payload: Record<string, unknown>) {
    if (editing) {
      await api.patch(`/api/reverse-proxy/${editing.id}`, payload);
      success('Reverse proxy updated', 'The node picks it up on the next reconcile.');
    } else {
      await api.post('/api/reverse-proxy', payload);
      success('Reverse proxy created', 'The node picks it up on the next reconcile.');
    }
    await reload();
  }

  async function toggle(row: ReverseRow) {
    setBusyId(row.id);
    try {
      await api.patch(`/api/reverse-proxy/${row.id}`, { enabled: !row.enabled });
      success(row.enabled ? 'Reverse proxy disabled' : 'Reverse proxy enabled');
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
      await api.delete(`/api/reverse-proxy/${deleting.id}`);
      success('Reverse proxy deleted', `${deleting.name} is removed on the next reconcile.`);
      setDeleting(null);
      await reload();
    } catch (caught) {
      toastError('Could not delete reverse proxy', describeError(caught));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reverse proxy"
        description="Xray's reverse block. A PORTAL on the node that needs connectivity and a BRIDGE on the node that has it — the Iran → Foreign tunnel."
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
              New entry
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Entries" value={pagination?.total ?? rows.length} icon={ArrowLeftRight} hint="Bridges + portals" />
        <StatCard
          label="Portals"
          value={rows.filter((row) => row.role === 'PORTAL').length}
          icon={Power}
          tone="success"
          hint="This page"
        />
        <StatCard
          label="Bridges"
          value={rows.filter((row) => row.role === 'BRIDGE').length}
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
          searchPlaceholder="Search reverse proxies…"
          filters={[
            {
              key: 'serverId',
              label: 'Server',
              value: serverId,
              options: servers.map((server) => ({ label: server.name, value: server.id })),
              allLabel: 'All servers',
            },
            {
              key: 'role',
              label: 'Role',
              value: roleFilter,
              options: [
                { label: 'Portal', value: 'PORTAL' },
                { label: 'Bridge', value: 'BRIDGE' },
              ],
              allLabel: 'All roles',
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
            if (key === 'role') setRoleFilter(value);
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
            <p className="text-sm font-medium">Could not load reverse proxies</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={ArrowLeftRight}
              title={hasFilters ? 'No entries match these filters' : 'No reverse proxy entries yet'}
              description={
                hasFilters
                  ? 'Try a different search or clear the filters.'
                  : 'Add a PORTAL on the Iran node and a BRIDGE on the Foreign node to link them.'
              }
              action={
                hasFilters ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSearch('');
                      setServerId('');
                      setRoleFilter('');
                      setEnabledFilter('');
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setDialogOpen(true)}>
                    <Plus className="size-4" />
                    New entry
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
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Tag</TableHead>
                  <TableHead className="hidden md:table-cell">Peer domain</TableHead>
                  <TableHead className="hidden lg:table-cell">Server</TableHead>
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
                          <ArrowLeftRight className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{row.name}</p>
                          {row.remarks ? (
                            <p className="truncate text-xs text-muted-foreground">{row.remarks}</p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-xs',
                          row.role === 'PORTAL'
                            ? 'border-success/40 bg-success/10 text-success'
                            : 'border-border bg-muted text-muted-foreground',
                        )}
                      >
                        {row.role}
                      </span>
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{row.tag}</code>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{row.domain}</code>
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                      {row.server?.name ?? '—'}
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
        These rows become <code>reverse.bridges[]</code> and <code>reverse.portals[]</code> in{' '}
        <code>config.json</code>. They are only emitted when at least one row exists, so a panel
        without reverse proxies renders exactly as before.
      </p>

      <AdvancedFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        title={editing ? 'Edit reverse proxy' : 'New reverse proxy entry'}
        description="One half of the tunnel. Create the matching half on the other server."
        fields={fieldsFor(servers)}
        initial={editing}
        submitLabel={editing ? 'Save changes' : 'Create entry'}
        onSubmit={save}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleting(null);
        }}
        title="Delete reverse proxy entry?"
        description={
          deleting
            ? `“${deleting.name}” is removed on the next reconcile. The matching half on the other server will stop connecting.`
            : undefined
        }
        confirmLabel="Delete entry"
        destructive
        loading={deleteBusy}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

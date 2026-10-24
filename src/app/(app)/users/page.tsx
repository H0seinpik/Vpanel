'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldOff,
  Trash2,
  UserPlus,
  Users as UsersIcon,
} from 'lucide-react';
import { api, ApiError, toQuery } from '@/lib/api-client';
import { useApi, useDebounced } from '@/hooks/use-api';
import { daysUntil, formatBytes, formatDate, formatRelative } from '@/lib/format';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ConfirmDialog,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton, EmptyState } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { StatCard } from '@/components/common/stat-card';
import { DataToolbar } from '@/components/common/data-toolbar';
import { Pagination, type PaginationMeta } from '@/components/common/pagination';
import { UsageBar } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

interface UserRow {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  role: string;
  status: string;
  trafficUsedBytes: number;
  trafficLimitBytes: number | null;
  expirationDate: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  _count?: { assignments: number; devices: number };
}

interface UsersResponse {
  data: UserRow[];
  pagination: PaginationMeta;
}

/** User list with search, filters, quota visibility and per-row admin actions. */
export default function UsersPage() {
  const toast = useToast();

  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [role, setRole] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const debouncedSearch = useDebounced(search);
  const path = `/api/users${toQuery({ search: debouncedSearch, status, role, page, pageSize })}`;

  const { data, loading, error, reload, refreshing } = useApi<UsersResponse>(path);

  const [resetTarget, setResetTarget] = React.useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = React.useState('');
  const [resetBusy, setResetBusy] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<UserRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, role]);

  async function toggleStatus(user: UserRow) {
    const next = user.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
    try {
      await api.patch(`/api/users/${user.id}`, { status: next });
      toast.success(next === 'DISABLED' ? 'User disabled' : 'User enabled', user.username);
      await reload();
    } catch (caught) {
      toast.error('Update failed', caught instanceof ApiError ? caught.message : undefined);
    }
  }

  async function submitReset() {
    if (!resetTarget || newPassword.length < 8) return;
    setResetBusy(true);
    try {
      await api.post(`/api/users/${resetTarget.id}/password`, {
        newPassword,
        revokeSessions: true,
      });
      toast.success('Password reset', `${resetTarget.username}'s sessions were revoked.`);
      setResetTarget(null);
      setNewPassword('');
    } catch (caught) {
      toast.error('Reset failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setResetBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/api/users/${deleteTarget.id}`);
      toast.success('User deleted', deleteTarget.username);
      setDeleteTarget(null);
      await reload();
    } catch (caught) {
      toast.error('Delete failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setDeleteBusy(false);
    }
  }

  // `data?.data ?? []` allocates a fresh array on every render, so it must be
  // memoised before it can be a stable useMemo dependency.
  const rows = React.useMemo(() => data?.data ?? [], [data]);

  const counters = React.useMemo(
    () => ({
      total: data?.pagination.total ?? 0,
      active: rows.filter((row) => row.status === 'ACTIVE').length,
      expired: rows.filter((row) => row.status === 'EXPIRED').length,
      exceeded: rows.filter((row) => row.status === 'TRAFFIC_EXCEEDED').length,
    }),
    [data, rows],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Accounts, quotas and expiry dates."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void reload()} loading={refreshing}>
              <RefreshCw /> Refresh
            </Button>
            <Button size="sm" asChild>
              <Link href="/users/new">
                <UserPlus /> Create user
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total users" value={counters.total} icon={UsersIcon} />
        <StatCard label="Active (this page)" value={counters.active} icon={UsersIcon} tone="success" />
        <StatCard label="Expired (this page)" value={counters.expired} icon={UsersIcon} tone="warning" />
        <StatCard
          label="Over quota (this page)"
          value={counters.exceeded}
          icon={UsersIcon}
          tone={counters.exceeded > 0 ? 'destructive' : 'default'}
        />
      </div>

      <Card className="overflow-hidden">
        <DataToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search username, email or name…"
          filters={[
            {
              key: 'status',
              label: 'Status',
              value: status,
              options: ['ACTIVE', 'EXPIRED', 'TRAFFIC_EXCEEDED', 'DISABLED', 'SUSPENDED'].map((value) => ({
                label: value.replace(/_/g, ' '),
                value,
              })),
            },
            {
              key: 'role',
              label: 'Role',
              value: role,
              options: ['ADMIN', 'OPERATOR', 'USER'].map((value) => ({ label: value, value })),
            },
          ]}
          onFilterChange={(key, value) => (key === 'status' ? setStatus(value) : setRole(value))}
        />

        {loading && !data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </div>
        ) : error ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium">Could not load users</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={UsersIcon}
            title="No users found"
            description={
              search || status || role
                ? 'Try adjusting your search or filters.'
                : 'Create your first account to start assigning configurations.'
            }
            action={
              !search && !status && !role ? (
                <Button size="sm" asChild>
                  <Link href="/users/new">
                    <Plus /> Create user
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
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[180px]">Traffic</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Configs</TableHead>
                  <TableHead>Last login</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((user) => {
                  const unlimited = user.trafficLimitBytes === null;
                  const percent = unlimited
                    ? 0
                    : Math.min(100, (user.trafficUsedBytes / (user.trafficLimitBytes || 1)) * 100);
                  const days = daysUntil(user.expirationDate);

                  return (
                    <TableRow key={user.id}>
                      <TableCell>
                        <Link href={`/users/${user.id}`} className="block">
                          <p className="font-medium hover:underline">
                            {user.displayName ?? user.username}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {user.username} · {user.email}
                          </p>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={user.role} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={user.status} />
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <UsageBar percent={percent} />
                          <p className="text-[11px] tabular-nums text-muted-foreground">
                            {formatBytes(user.trafficUsedBytes)} /{' '}
                            {unlimited ? 'unlimited' : formatBytes(user.trafficLimitBytes)}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {user.expirationDate ? (
                          <>
                            <p>{formatDate(user.expirationDate)}</p>
                            <p
                              className={
                                days !== null && days < 0
                                  ? 'text-destructive'
                                  : days !== null && days <= 7
                                    ? 'text-warning'
                                    : 'text-muted-foreground'
                              }
                            >
                              {days === null
                                ? ''
                                : days < 0
                                  ? `expired ${Math.abs(days)}d ago`
                                  : `${days}d left`}
                            </p>
                          </>
                        ) : (
                          <span className="text-muted-foreground">Never</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">
                        {user._count?.assignments ?? 0}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelative(user.lastLoginAt)}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${user.username}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/users/${user.id}`}>View details</Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setResetTarget(user)}>
                              <KeyRound /> Reset password
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void toggleStatus(user)}>
                              <ShieldOff />
                              {user.status === 'DISABLED' ? 'Enable account' : 'Disable account'}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => setDeleteTarget(user)}
                            >
                              <Trash2 /> Delete user
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
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

      {/* Password reset */}
      <Dialog open={Boolean(resetTarget)} onOpenChange={(open) => !open && setResetTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Set a new password for <strong>{resetTarget?.username}</strong>. All of their active
              sessions will be revoked.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="text"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="At least 8 characters, mixed case and a number"
            />
            <p className="text-xs text-muted-foreground">
              Share this with the user over a secure channel; it is stored only as a hash.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitReset()}
              loading={resetBusy}
              disabled={newPassword.length < 8}
            >
              Reset password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete "${deleteTarget?.username}"?`}
        description="This removes the account, its assignments and its devices. Traffic history is retained for reporting. This cannot be undone."
        confirmLabel="Delete user"
        destructive
        loading={deleteBusy}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

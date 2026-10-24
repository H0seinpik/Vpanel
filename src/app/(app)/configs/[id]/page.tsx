'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Plus,
  RefreshCw,
  Server as ServerIcon,
  Trash2,
  UserMinus,
  Users as UsersIcon,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useApi } from '@/hooks/use-api';
import { formatAllowance, formatBytes, formatDateTime, formatRemaining, remainingBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ConfirmDialog,
} from '@/components/ui/dialog';
import { Checkbox, UsageBar } from '@/components/ui/primitives';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PageHeader } from '@/components/common/page-header';
import { ConfigActions } from '@/components/configs/config-actions';
import { useToast } from '@/components/ui/toast';

interface ConfigDetailResponse {
  config: {
    id: string;
    name: string;
    type: string;
    status: string;
    params: Record<string, unknown>;
    remarks: string | null;
    /** The configuration's own ceiling (null = unlimited). */
    trafficLimitBytes: number | null;
    /** Running total across every assignment. */
    trafficUsedBytes: number;
    createdAt: string;
    updatedAt: string;
    server?: { id: string; name: string; hostname: string; location: string | null; status: string };
    owner: { id: string; username: string; displayName: string | null } | null;
  };
  assignments: Array<{
    id: string;
    userId: string;
    status: string;
    trafficUsedBytes: number;
    user?: { id: string; username: string; displayName: string | null; email: string };
  }>;
  shareLink: string | null;
}

/** True when 90%+ of the allowance is gone, so the remaining figure warns. */
function isLowRemaining(used: number, limit: number | null): boolean {
  const remaining = remainingBytes(used, limit);
  if (remaining === null || limit === null || limit <= 0) return false;
  return remaining <= limit * 0.1;
}

interface UserOption {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
}

/**
 * Configuration detail.
 *
 * Lists every assignment with a per-user delivery action, so an administrator
 * can hand each user their own credential without ever exposing it to the
 * others. Adding a user mints a brand-new credential for them.
 */
export default function ConfigDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const id = params?.id;
  const { data, loading, error, reload, refreshing } = useApi<ConfigDetailResponse>(
    id ? `/api/configs/${id}` : null,
  );

  const users = useApi<{ data: UserOption[] }>('/api/users?pageSize=200');

  const [assignOpen, setAssignOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [assignBusy, setAssignBusy] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<{ userId: string; label: string } | null>(null);
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  // --- Traffic allowance editing ---------------------------------------------
  const [limitValue, setLimitValue] = React.useState('');
  const [limitUnit, setLimitUnit] = React.useState<'GB' | 'MB'>('GB');
  const [savingLimit, setSavingLimit] = React.useState(false);
  const [resettingTraffic, setResettingTraffic] = React.useState(false);

  // Hydrate the limit field once the record loads, guessing the friendlier unit.
  React.useEffect(() => {
    if (!data) return;
    const bytes = data.config.trafficLimitBytes;
    if (bytes === null) {
      setLimitValue('');
      setLimitUnit('GB');
      return;
    }
    if (bytes < 1024 ** 3) {
      setLimitUnit('MB');
      setLimitValue(String(Math.round(bytes / 1024 ** 2)));
    } else {
      setLimitUnit('GB');
      setLimitValue(String(Math.round((bytes / 1024 ** 3) * 100) / 100));
    }
  }, [data]);

  async function saveLimit() {
    if (!id) return;
    setSavingLimit(true);
    try {
      await api.patch(`/api/configs/${id}`, {
        ...(limitValue === ''
          ? { trafficLimitGb: null }
          : limitUnit === 'MB'
            ? { trafficLimitMb: Number(limitValue) }
            : { trafficLimitGb: Number(limitValue) }),
      });
      toast.success('Limit saved', limitValue === '' ? 'Now unlimited.' : 'The configuration will stop at the new limit.');
      await reload();
    } catch (caught) {
      toast.error('Save failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSavingLimit(false);
    }
  }

  async function resetTraffic() {
    if (!id) return;
    setResettingTraffic(true);
    try {
      await api.patch(`/api/configs/${id}`, { resetTraffic: true });
      toast.success('Counter reset', 'The configuration is serving again.');
      await reload();
    } catch (caught) {
      toast.error('Reset failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setResettingTraffic(false);
    }
  }

  const assignedIds = new Set((data?.assignments ?? []).map((assignment) => assignment.userId));

  async function assign() {
    if (!id || selected.length === 0) return;
    setAssignBusy(true);
    try {
      await api.post(`/api/configs/${id}/assignments`, { userIds: selected });
      toast.success(
        'Users assigned',
        `${selected.length} user(s) received an independent credential.`,
      );
      setSelected([]);
      setAssignOpen(false);
      await reload();
    } catch (caught) {
      toast.error('Assignment failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setAssignBusy(false);
    }
  }

  async function confirmRemove() {
    if (!id || !removeTarget) return;
    setRemoveBusy(true);
    try {
      await api.delete(`/api/configs/${id}/assignments?userId=${removeTarget.userId}`);
      toast.success('Assignment removed', removeTarget.label);
      setRemoveTarget(null);
      await reload();
    } catch (caught) {
      toast.error('Removal failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setRemoveBusy(false);
    }
  }

  async function confirmDelete() {
    if (!id) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/api/configs/${id}`);
      toast.success('Configuration deleted');
      router.push('/configs');
    } catch (caught) {
      toast.error('Delete failed', caught instanceof ApiError ? caught.message : undefined);
      setDeleteBusy(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <AlertTriangle className="size-6 text-destructive" />
          <p className="text-sm font-medium">Could not load this configuration</p>
          <p className="text-sm text-muted-foreground">{error?.message}</p>
          <Button variant="outline" asChild>
            <Link href="/configs">
              <ArrowLeft /> Back to configurations
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const config = data.config;

  return (
    <div className="space-y-6">
      <PageHeader
        title={config.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status="INFO" label={config.type} />
            <StatusBadge status={config.status} />
            {config.server ? (
              <span className="flex items-center gap-1">
                <ServerIcon className="size-3" /> {config.server.name}
                {config.server.location ? ` · ${config.server.location}` : ''}
              </span>
            ) : null}
          </span>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/configs">
                <ArrowLeft /> Back
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void reload()} loading={refreshing}>
              <RefreshCw /> Refresh
            </Button>
            <Button size="sm" onClick={() => setAssignOpen(true)}>
              <Plus /> Assign users
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
              <Trash2 /> Delete
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Configuration parameters</CardTitle>
            <CardDescription>
              Credentials are stored per user and are never part of the shared parameters.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-relaxed">
              {JSON.stringify(config.params, null, 2)}
            </pre>
            {config.remarks ? (
              <p className="mt-3 text-sm text-muted-foreground">{config.remarks}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Owner" value={config.owner?.displayName ?? config.owner?.username ?? '—'} />
            <Row label="Assigned users" value={data.assignments.length} />
            <Row label="Server" value={config.server ? `${config.server.name} (${config.server.status})` : '—'} />
            <Row label="Created" value={formatDateTime(config.createdAt)} />
            <Row label="Updated" value={formatDateTime(config.updatedAt)} />
          </CardContent>
        </Card>
      </div>

      {/* Traffic allowance ------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Traffic allowance</CardTitle>
          <CardDescription>
            This configuration&apos;s own limit. Reaching it stops the configuration
            automatically and its clients can no longer connect.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Consumed</span>
              <span className="tabular-nums">
                {formatBytes(config.trafficUsedBytes)} /{' '}
                {formatAllowance(config.trafficLimitBytes)}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Remaining</span>
              <span
                className={cn(
                  'font-medium tabular-nums',
                  isLowRemaining(config.trafficUsedBytes, config.trafficLimitBytes)
                    ? 'text-destructive'
                    : 'text-emerald-500',
                )}
              >
                {formatRemaining(config.trafficUsedBytes, config.trafficLimitBytes)}
              </span>
            </div>
            <UsageBar
              percent={
                config.trafficLimitBytes && config.trafficLimitBytes > 0
                  ? Math.min(100, (config.trafficUsedBytes / config.trafficLimitBytes) * 100)
                  : 0
              }
              showLabel
            />
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="cfg-limit">Limit</Label>
              <div className="flex gap-2">
                <Input
                  id="cfg-limit"
                  type="number"
                  min={0}
                  value={limitValue}
                  onChange={(event) => setLimitValue(event.target.value)}
                  placeholder="Blank = unlimited"
                  className="w-32"
                />
                <Select value={limitUnit} onValueChange={(value) => setLimitUnit(value as 'GB' | 'MB')}>
                  <SelectTrigger className="w-[84px]" aria-label="Limit unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GB">GB</SelectItem>
                    <SelectItem value="MB">MB</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={() => void saveLimit()} loading={savingLimit}>
              Save limit
            </Button>
            <Button variant="outline" onClick={() => void resetTraffic()} loading={resettingTraffic}>
              Reset counter
            </Button>
          </div>

          {config.status === 'TRAFFIC_EXCEEDED' ? (
            <p className="text-sm text-destructive">
              This configuration was stopped automatically because it reached its limit. Raise the
              limit or reset the counter to resume it.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle>Assigned users</CardTitle>
            <CardDescription>
              Each user has their own credential and import link.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
            <UsersIcon /> Assign
          </Button>
        </CardHeader>

        {data.assignments.length === 0 ? (
          <CardContent>
            <p className="py-8 text-center text-sm text-muted-foreground">
              No users assigned yet. Assign a user to generate their credential.
            </p>
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Traffic used</TableHead>
                <TableHead className="w-[140px]">Delivery</TableHead>
                <TableHead className="w-[90px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.assignments.map((assignment) => (
                <TableRow key={assignment.id}>
                  <TableCell>
                    <p className="font-medium">
                      {assignment.user?.displayName ?? assignment.user?.username ?? assignment.userId}
                    </p>
                    <p className="text-xs text-muted-foreground">{assignment.user?.email ?? '—'}</p>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={assignment.status} />
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {new Intl.NumberFormat('en', { notation: 'compact' }).format(
                      assignment.trafficUsedBytes,
                    )}{' '}
                    B
                  </TableCell>
                  <TableCell>
                    <ConfigActions
                      configId={config.id}
                      name={config.name}
                      protocol={config.type}
                      userId={assignment.userId}
                      compact
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() =>
                        setRemoveTarget({
                          userId: assignment.userId,
                          label: assignment.user?.username ?? assignment.userId,
                        })
                      }
                    >
                      <UserMinus /> Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Assign users */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign users</DialogTitle>
            <DialogDescription>
              Each selected user receives a freshly generated, independent credential.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border p-2">
            {(users.data?.data ?? [])
              .filter((user) => !assignedIds.has(user.id))
              .map((user) => (
                <label
                  key={user.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <Checkbox
                    checked={selected.includes(user.id)}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked ? [...current, user.id] : current.filter((value) => value !== user.id),
                      )
                    }
                  />
                  <span className="truncate">
                    {user.displayName ?? user.username}
                    <span className="ml-1 text-xs text-muted-foreground">{user.email}</span>
                  </span>
                </label>
              ))}
            {(users.data?.data ?? []).filter((user) => !assignedIds.has(user.id)).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Every user is already assigned to this configuration.
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void assign()} loading={assignBusy} disabled={selected.length === 0}>
              Assign {selected.length > 0 ? `(${selected.length})` : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title={`Remove ${removeTarget?.label}?`}
        description="Their credential for this configuration is deleted immediately. This cannot be undone."
        confirmLabel="Remove user"
        destructive
        loading={removeBusy}
        onConfirm={confirmRemove}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${config.name}"?`}
        description="Every assigned user loses access immediately. This cannot be undone."
        confirmLabel="Delete configuration"
        destructive
        loading={deleteBusy}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-0">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

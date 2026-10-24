'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarPlus,
  KeyRound,
  Save,
  ShieldOff,
  Trash2,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useApi } from '@/hooks/use-api';
import { daysUntil, formatBytes, formatDate, formatDateTime, formatRelative } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger, UsageBar } from '@/components/ui/primitives';
import { PageHeader } from '@/components/common/page-header';
import { StatCard } from '@/components/common/stat-card';
import { ConfigActions } from '@/components/configs/config-actions';
import { useToast } from '@/components/ui/toast';

interface UserDetailResponse {
  user: {
    id: string;
    username: string;
    displayName: string | null;
    email: string;
    role: string;
    status: string;
    notes: string | null;
    trafficUsedBytes: number;
    trafficLimitBytes: number | null;
    expirationDate: string | null;
    lastLoginAt: string | null;
    createdAt: string;
  };
  plan: { id: string; name: string; deviceLimit: number } | null;
  assignments: Array<{
    id: string;
    name: string;
    type: string;
    status: string;
    server?: { id: string; name: string; location: string | null; status: string };
  }>;
  devices: Array<{
    id: string;
    name: string;
    platform: string;
    status: string;
    lastSeenAt: string | null;
    createdAt: string;
  }>;
  counters: { assignments: number; devices: number; sessions: number };
}

/** User detail: profile, quota controls, configurations and devices. */
export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const id = params?.id;
  const { data, loading, error, reload, refreshing } = useApi<UserDetailResponse>(
    id ? `/api/users/${id}` : null,
  );

  const [edit, setEdit] = React.useState({
    displayName: '',
    email: '',
    role: 'USER',
    status: 'ACTIVE',
    trafficLimitGb: '',
    extendDays: '',
    notes: '',
  });
  const [saving, setSaving] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [newPassword, setNewPassword] = React.useState('');
  const [resetBusy, setResetBusy] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  // Hydrate the edit form once the record loads.
  React.useEffect(() => {
    if (!data) return;
    setEdit({
      displayName: data.user.displayName ?? '',
      email: data.user.email,
      role: data.user.role,
      status: data.user.status,
      trafficLimitGb:
        data.user.trafficLimitBytes === null
          ? ''
          : String(Math.round(data.user.trafficLimitBytes / 1024 ** 3)),
      extendDays: '',
      notes: data.user.notes ?? '',
    });
  }, [data]);

  async function save() {
    if (!id) return;
    setSaving(true);
    try {
      await api.patch(`/api/users/${id}`, {
        displayName: edit.displayName || null,
        email: edit.email,
        role: edit.role,
        status: edit.status,
        notes: edit.notes || null,
        trafficLimitGb: edit.trafficLimitGb === '' ? null : Number(edit.trafficLimitGb),
        ...(edit.extendDays ? { extendDays: Number(edit.extendDays) } : {}),
      });
      toast.success('Changes saved');
      setEdit((current) => ({ ...current, extendDays: '' }));
      await reload();
    } catch (caught) {
      toast.error('Save failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  async function resetTraffic() {
    if (!id) return;
    try {
      await api.patch(`/api/users/${id}`, { resetTraffic: true });
      toast.success('Traffic counter reset');
      await reload();
    } catch (caught) {
      toast.error('Reset failed', caught instanceof ApiError ? caught.message : undefined);
    }
  }

  async function toggleDisabled() {
    if (!id || !data) return;
    const next = data.user.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
    try {
      await api.patch(`/api/users/${id}`, { status: next });
      toast.success(next === 'DISABLED' ? 'Account disabled' : 'Account enabled');
      await reload();
    } catch (caught) {
      toast.error('Update failed', caught instanceof ApiError ? caught.message : undefined);
    }
  }

  async function submitReset() {
    if (!id || newPassword.length < 8) return;
    setResetBusy(true);
    try {
      await api.post(`/api/users/${id}/password`, { newPassword, revokeSessions: true });
      toast.success('Password reset', 'Active sessions were revoked.');
      setResetOpen(false);
      setNewPassword('');
      await reload();
    } catch (caught) {
      toast.error('Reset failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setResetBusy(false);
    }
  }

  async function confirmDelete() {
    if (!id) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/api/users/${id}`);
      toast.success('User deleted');
      router.push('/users');
    } catch (caught) {
      toast.error('Delete failed', caught instanceof ApiError ? caught.message : undefined);
      setDeleteBusy(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <AlertTriangle className="size-6 text-destructive" />
          <p className="text-sm font-medium">Could not load this user</p>
          <p className="text-sm text-muted-foreground">{error?.message}</p>
          <Button variant="outline" asChild>
            <Link href="/users">
              <ArrowLeft /> Back to users
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const user = data.user;
  const unlimited = user.trafficLimitBytes === null;
  const percent = unlimited ? 0 : Math.min(100, (user.trafficUsedBytes / (user.trafficLimitBytes || 1)) * 100);
  const days = daysUntil(user.expirationDate);

  return (
    <div className="space-y-6">
      <PageHeader
        title={user.displayName ?? user.username}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{user.email}</span>
            <StatusBadge status={user.role} />
            <StatusBadge status={user.status} />
            {data.plan ? <StatusBadge status="INFO" label={data.plan.name} /> : null}
          </span>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/users">
                <ArrowLeft /> Back
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void reload()} loading={refreshing}>
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
              <KeyRound /> Reset password
            </Button>
            <Button variant="outline" size="sm" onClick={() => void toggleDisabled()}>
              <ShieldOff /> {user.status === 'DISABLED' ? 'Enable' : 'Disable'}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
              <Trash2 /> Delete
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Traffic used"
          value={formatBytes(user.trafficUsedBytes)}
          hint={unlimited ? 'Unlimited allowance' : `of ${formatBytes(user.trafficLimitBytes)}`}
          tone={percent >= 90 ? 'destructive' : percent >= 80 ? 'warning' : 'default'}
        />
        <StatCard
          label="Expires"
          value={days === null ? 'Never' : days < 0 ? 'Expired' : `${days} days`}
          hint={user.expirationDate ? formatDate(user.expirationDate) : 'No expiration date'}
          tone={days !== null && days < 0 ? 'destructive' : days !== null && days <= 7 ? 'warning' : 'default'}
        />
        <StatCard label="Configurations" value={data.counters.assignments} tone="accent" />
        <StatCard label="Devices" value={data.counters.devices} hint={`${data.counters.sessions} sessions`} />
      </div>

      <Card>
        <CardContent className="space-y-2 pt-5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Traffic allowance</span>
            <span className="tabular-nums">
              {formatBytes(user.trafficUsedBytes)} / {unlimited ? 'Unlimited' : formatBytes(user.trafficLimitBytes)}
            </span>
          </div>
          <UsageBar percent={percent} showLabel />
          <div className="flex justify-end pt-2">
            <Button variant="ghost" size="sm" onClick={() => void resetTraffic()}>
              Reset usage counter
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="manage">
        <TabsList>
          <TabsTrigger value="manage">Manage</TabsTrigger>
          <TabsTrigger value="configs">Configurations ({data.counters.assignments})</TabsTrigger>
          <TabsTrigger value="devices">Devices ({data.counters.devices})</TabsTrigger>
        </TabsList>

        <TabsContent value="manage">
          <Card>
            <CardHeader>
              <CardTitle>Account settings</CardTitle>
              <CardDescription>
                Quota, expiry and access level. Changes are recorded in the audit log.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="displayName">Display name</Label>
                <Input
                  id="displayName"
                  value={edit.displayName}
                  onChange={(event) => setEdit((current) => ({ ...current, displayName: event.target.value }))}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={edit.email}
                  onChange={(event) => setEdit((current) => ({ ...current, email: event.target.value }))}
                />
              </div>

              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select value={edit.role} onValueChange={(value) => setEdit((current) => ({ ...current, role: value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USER">User</SelectItem>
                    <SelectItem value="OPERATOR">Operator</SelectItem>
                    <SelectItem value="ADMIN">Administrator</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={edit.status} onValueChange={(value) => setEdit((current) => ({ ...current, status: value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                    <SelectItem value="SUSPENDED">Suspended</SelectItem>
                    <SelectItem value="DISABLED">Disabled</SelectItem>
                    <SelectItem value="EXPIRED">Expired</SelectItem>
                    <SelectItem value="TRAFFIC_EXCEEDED">Traffic exceeded</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="limit">Traffic limit (GB)</Label>
                <Input
                  id="limit"
                  type="number"
                  min={0}
                  value={edit.trafficLimitGb}
                  onChange={(event) => setEdit((current) => ({ ...current, trafficLimitGb: event.target.value }))}
                  placeholder="Blank = unlimited"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="extend" className="flex items-center gap-1">
                  <CalendarPlus className="size-3.5" /> Extend by (days)
                </Label>
                <Input
                  id="extend"
                  type="number"
                  min={1}
                  value={edit.extendDays}
                  onChange={(event) => setEdit((current) => ({ ...current, extendDays: event.target.value }))}
                  placeholder="e.g. 30"
                />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  value={edit.notes}
                  onChange={(event) => setEdit((current) => ({ ...current, notes: event.target.value }))}
                />
              </div>

              <div className="flex justify-end sm:col-span-2">
                <Button onClick={() => void save()} loading={saving}>
                  <Save /> Save changes
                </Button>
              </div>

              <div className="sm:col-span-2">
                <div className="grid gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground sm:grid-cols-2">
                  <p>Username: <span className="font-mono">{user.username}</span></p>
                  <p>Created: {formatDateTime(user.createdAt)}</p>
                  <p>Last login: {formatDateTime(user.lastLoginAt)}</p>
                  <p>Plan: {data.plan?.name ?? 'Custom'}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="configs">
          <Card className="overflow-hidden">
            {data.assignments.length === 0 ? (
              <p className="p-10 text-center text-sm text-muted-foreground">
                No configurations assigned yet. Create one from the Configurations page.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Configuration</TableHead>
                    <TableHead>Server</TableHead>
                    <TableHead>Protocol</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[120px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.assignments.map((assignment) => (
                    <TableRow key={assignment.id}>
                      <TableCell>
                        <Link href={`/configs/${assignment.id}`} className="font-medium hover:underline">
                          {assignment.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {assignment.server?.name ?? '—'}
                        {assignment.server?.location ? ` · ${assignment.server.location}` : ''}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status="INFO" label={assignment.type} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={assignment.status} />
                      </TableCell>
                      <TableCell>
                        <ConfigActions
                          configId={assignment.id}
                          name={assignment.name}
                          protocol={assignment.type}
                          userId={user.id}
                          compact
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="devices">
          <Card className="overflow-hidden">
            {data.devices.length === 0 ? (
              <p className="p-10 text-center text-sm text-muted-foreground">No devices registered.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Device</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last seen</TableHead>
                    <TableHead>Registered</TableHead>
                    <TableHead className="w-[90px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.devices.map((device) => (
                    <TableRow key={device.id}>
                      <TableCell className="font-medium">{device.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{device.platform}</TableCell>
                      <TableCell>
                        <StatusBadge status={device.status} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelative(device.lastSeenAt)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(device.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            try {
                              await api.delete(`/api/devices/${device.id}`);
                              toast.success('Device revoked');
                              await reload();
                            } catch (caught) {
                              toast.error('Failed', caught instanceof ApiError ? caught.message : undefined);
                            }
                          }}
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      {/* Password reset */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Set a new password for <strong>{user.username}</strong>. All active sessions will be
              revoked immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pw">New password</Label>
            <Input
              id="pw"
              type="text"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="At least 8 characters, mixed case and a number"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submitReset()} loading={resetBusy} disabled={newPassword.length < 8}>
              Reset password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${user.username}"?`}
        description="This removes the account, its assignments and devices. Traffic history is retained. This cannot be undone."
        confirmLabel="Delete user"
        destructive
        loading={deleteBusy}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

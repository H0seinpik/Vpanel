'use client';

import * as React from 'react';
import { AlertTriangle, KeyRound, Save, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useApi } from '@/hooks/use-api';
import { formatBytes, formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, initialsOf } from '@/components/ui/avatar';
import { PageHeader } from '@/components/common/page-header';
import { useToast } from '@/components/ui/toast';

interface MeResponse {
  user: {
    id: string;
    username: string;
    email: string;
    displayName: string | null;
    role: string;
    status: string;
    expirationDate: string | null;
    trafficUsedBytes: number;
    trafficLimitBytes: number | null;
  };
  capabilities: string[];
}

/** Own profile: contact details, password change and account summary. */
export default function ProfilePage() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<MeResponse>('/api/auth/me');

  const [displayName, setDisplayName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [savingProfile, setSavingProfile] = React.useState(false);

  const [passwords, setPasswords] = React.useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [savingPassword, setSavingPassword] = React.useState(false);

  React.useEffect(() => {
    if (!data) return;
    setDisplayName(data.user.displayName ?? '');
    setEmail(data.user.email);
  }, [data]);

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setSavingProfile(true);
    try {
      await api.patch('/api/me/profile', { displayName, email });
      toast.success('Profile updated');
      await reload();
    } catch (caught) {
      toast.error('Update failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (passwords.newPassword !== passwords.confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    setSavingPassword(true);
    try {
      await api.post('/api/auth/password', passwords);
      toast.success('Password changed', 'You will be signed out of all devices.');
      setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
      // Sessions were revoked server-side; send the user back to sign in.
      setTimeout(() => {
        window.location.href = '/login';
      }, 1500);
    } catch (caught) {
      toast.error('Change failed', caught instanceof ApiError ? caught.message : undefined);
      setSavingPassword(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="My profile" />
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
          <p className="text-sm font-medium">Could not load your profile</p>
          <p className="text-sm text-muted-foreground">{error?.message}</p>
          <Button onClick={() => void reload()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const user = data.user;
  const unlimited = user.trafficLimitBytes === null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="My profile" description="Your account details and credentials." />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 pt-5">
          <Avatar className="size-14">
            <AvatarFallback className="text-lg">{initialsOf(user.displayName ?? user.username)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">{user.displayName ?? user.username}</p>
            <p className="text-sm text-muted-foreground">{user.email}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <StatusBadge status={user.role} />
              <StatusBadge status={user.status} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Username</p>
              <p className="font-mono">{user.username}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Traffic used</p>
              <p className="tabular-nums">
                {formatBytes(user.trafficUsedBytes)}
                {!unlimited ? ` / ${formatBytes(user.trafficLimitBytes)}` : ''}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Expires</p>
              <p>{user.expirationDate ? formatDateTime(user.expirationDate) : 'Never'}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contact details</CardTitle>
          <CardDescription>
            Role, quotas and expiry can only be changed by an administrator.
          </CardDescription>
        </CardHeader>
        <form onSubmit={saveProfile}>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="displayName">Display name</Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="flex justify-end sm:col-span-2">
              <Button type="submit" loading={savingProfile}>
                <Save /> Save changes
              </Button>
            </div>
          </CardContent>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" /> Change password
          </CardTitle>
          <CardDescription>
            Changing your password signs you out of every device, including this one.
          </CardDescription>
        </CardHeader>
        <form onSubmit={changePassword}>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="current">Current password</Label>
              <Input
                id="current"
                type="password"
                autoComplete="current-password"
                value={passwords.currentPassword}
                onChange={(event) =>
                  setPasswords((current) => ({ ...current, currentPassword: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new">New password</Label>
              <Input
                id="new"
                type="password"
                autoComplete="new-password"
                value={passwords.newPassword}
                onChange={(event) =>
                  setPasswords((current) => ({ ...current, newPassword: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={passwords.confirmPassword}
                onChange={(event) =>
                  setPasswords((current) => ({ ...current, confirmPassword: event.target.value }))
                }
              />
            </div>
            <div className="flex justify-end sm:col-span-2">
              <Button
                type="submit"
                loading={savingPassword}
                disabled={
                  !passwords.currentPassword ||
                  passwords.newPassword.length < 8 ||
                  passwords.newPassword !== passwords.confirmPassword
                }
              >
                Change password
              </Button>
            </div>
          </CardContent>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" /> Your permissions
          </CardTitle>
          <CardDescription>
            Capabilities granted by your role. Authorisation is always re-checked on the server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {data.capabilities.map((capability) => (
              <span
                key={capability}
                className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px]"
              >
                {capability}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

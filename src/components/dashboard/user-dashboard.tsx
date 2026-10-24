'use client';

import * as React from 'react';
import { AlertTriangle, CalendarClock, Gauge, Server, ShieldCheck, Smartphone, Wifi } from 'lucide-react';
import { daysUntil, formatBytes, formatDate, formatRelative } from '@/lib/format';
import { useApi } from '@/hooks/use-api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { UsageBar } from '@/components/ui/primitives';
import { TrafficAreaChart } from '@/components/charts';
import { ConfigActions } from '@/components/configs/config-actions';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api-client';

interface UserDashboardResponse {
  user: {
    id: string;
    username: string;
    displayName: string | null;
    email: string;
    status: string;
    expirationDate: string | null;
    daysRemaining: number | null;
  };
  plan: { id: string; name: string; durationDays: number; deviceLimit: number } | null;
  traffic: {
    usedBytes: number;
    limitBytes: number | null;
    remainingBytes: number | null;
    percent: number;
    unlimited: boolean;
    uploadBytes: number;
    downloadBytes: number;
  };
  servers: Array<{ id: string; name: string; location: string | null; status: string }>;
  configurations: Array<{
    assignmentId: string;
    configId: string;
    name: string;
    protocol: string;
    status: string;
    serverName: string;
    serverLocation: string | null;
    shareLink: string | null;
    trafficUsedBytes: number;
  }>;
  usageOverTime: Array<{ bucket: string; totalBytes: number }>;
  devices: Array<{ id: string; name: string; platform: string; status: string; lastSeenAt: string | null }>;
}

/**
 * Personal dashboard.
 *
 * Shows exactly one user's plan, allowance, expiry, servers and configurations.
 * Every figure is computed by the backend; the page only formats it.
 */
export function UserDashboard() {
  const toast = useToast();
  const { data, loading, error, reload, refreshing } = useApi<UserDashboardResponse>(
    '/api/me/dashboard',
    { refreshInterval: 60_000 },
  );

  const [registering, setRegistering] = React.useState(false);

  async function registerThisDevice() {
    setRegistering(true);
    try {
      const platform = /android/i.test(navigator.userAgent)
        ? 'ANDROID'
        : /iphone|ipad|ios/i.test(navigator.userAgent)
          ? 'IOS'
          : /mac/i.test(navigator.userAgent)
            ? 'MACOS'
            : /linux/i.test(navigator.userAgent)
              ? 'LINUX'
              : 'WINDOWS';

      await api.post('/api/devices', {
        name: `${platform.charAt(0)}${platform.slice(1).toLowerCase()} device`,
        platform,
        deviceKey: `web-${navigator.userAgent.slice(0, 40)}`,
        userAgent: navigator.userAgent.slice(0, 200),
      });
      toast.success('Device registered');
      await reload();
    } catch (caught) {
      toast.error('Could not register device', caught instanceof Error ? caught.message : undefined);
    } finally {
      setRegistering(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="My dashboard" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <AlertTriangle className="size-6 text-destructive" />
          <p className="text-sm font-medium">Could not load your dashboard</p>
          <p className="text-sm text-muted-foreground">{error?.message}</p>
          <Button onClick={() => void reload()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const days = daysUntil(data.user.expirationDate);
  const statusHint =
    data.user.status === 'ACTIVE'
      ? 'Your service is active.'
      : data.user.status === 'TRAFFIC_EXCEEDED'
        ? 'Your traffic allowance is exhausted.'
        : data.user.status === 'EXPIRED'
          ? 'Your subscription has expired.'
          : 'Your account is not currently active.';

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome back, ${data.user.displayName ?? data.user.username}`}
        description={statusHint}
        actions={
          <>
            <StatusBadge status={data.user.status} />
            <Button variant="outline" size="sm" onClick={() => void reload()} loading={refreshing}>
              Refresh
            </Button>
          </>
        }
      />

      {/* Plan + traffic + expiry */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription className="flex items-center gap-2">
              <Gauge className="size-4" /> Traffic
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-2xl font-semibold tabular-nums">{formatBytes(data.traffic.usedBytes)}</p>
              <p className="text-xs text-muted-foreground">
                used of {data.traffic.unlimited ? 'unlimited' : formatBytes(data.traffic.limitBytes)}
              </p>
            </div>
            <UsageBar percent={data.traffic.percent} showLabel />
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md bg-muted/50 p-2">
                <p className="text-muted-foreground">Remaining</p>
                <p className="font-medium tabular-nums">
                  {data.traffic.unlimited ? 'Unlimited' : formatBytes(data.traffic.remainingBytes)}
                </p>
              </div>
              <div className="rounded-md bg-muted/50 p-2">
                <p className="text-muted-foreground">This month</p>
                <p className="font-medium tabular-nums">
                  {formatBytes(data.traffic.uploadBytes + data.traffic.downloadBytes)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription className="flex items-center gap-2">
              <CalendarClock className="size-4" /> Expiration
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-2xl font-semibold tabular-nums">
              {days === null ? 'No expiry' : days > 0 ? `${days} days` : 'Expired'}
            </p>
            <p className="text-xs text-muted-foreground">
              {data.user.expirationDate ? `Ends ${formatDate(data.user.expirationDate)}` : 'No expiration date set'}
            </p>
            {days !== null && days <= 7 && days >= 0 ? (
              <p className="flex items-center gap-1 text-xs font-medium text-warning">
                <AlertTriangle className="size-3" /> Renew soon to avoid interruption
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription className="flex items-center gap-2">
              <ShieldCheck className="size-4" /> Plan & devices
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-2xl font-semibold">{data.plan?.name ?? 'Custom'}</p>
            <p className="text-xs text-muted-foreground">
              {data.plan
                ? `${data.plan.durationDays}-day plan · up to ${data.plan.deviceLimit} device(s)`
                : 'Individually provisioned account'}
            </p>
            <p className="text-xs text-muted-foreground">
              {data.devices.length} registered device(s)
            </p>
            <Button variant="outline" size="sm" onClick={() => void registerThisDevice()} loading={registering}>
              <Smartphone /> Register this device
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Configurations */}
      <Card>
        <CardHeader>
          <CardTitle>My configurations</CardTitle>
          <CardDescription>
            Copy a link, show the QR code, or download the client file.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.configurations.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No configurations have been assigned to your account yet.
            </p>
          ) : (
            data.configurations.map((config) => (
              <div
                key={config.assignmentId}
                className="flex flex-col gap-3 rounded-lg border border-border p-4 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{config.name}</span>
                    <StatusBadge status={config.status} />
                    <StatusBadge status="INFO" label={config.protocol} />
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Server className="size-3" /> {config.serverName}
                      {config.serverLocation ? ` · ${config.serverLocation}` : ''}
                    </span>
                    <span className="flex items-center gap-1">
                      <Wifi className="size-3" /> {formatBytes(config.trafficUsedBytes)} used
                    </span>
                  </div>
                </div>

                <ConfigActions
                  configId={config.configId}
                  name={config.name}
                  protocol={config.protocol}
                  shareLink={config.shareLink}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Usage history */}
      <Card>
        <CardHeader>
          <CardTitle>My usage, last 30 days</CardTitle>
          <CardDescription>Daily transferred volume</CardDescription>
        </CardHeader>
        <CardContent>
          {data.usageOverTime.length ? (
            <TrafficAreaChart
              data={data.usageOverTime.map((point) => ({
                bucket: point.bucket,
                uploadBytes: 0,
                downloadBytes: point.totalBytes,
              }))}
            />
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No usage recorded yet. Connect a client and traffic will appear here.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Servers + devices */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Servers</CardTitle>
            <CardDescription>Nodes your configurations use</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.servers.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No servers assigned.</p>
            ) : (
              data.servers.map((server) => (
                <div
                  key={server.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{server.name}</p>
                    <p className="text-xs text-muted-foreground">{server.location ?? 'Location not set'}</p>
                  </div>
                  <StatusBadge status={server.status} />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>My devices</CardTitle>
            <CardDescription>Authorized client registrations</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.devices.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No devices registered.</p>
            ) : (
              data.devices.map((device) => (
                <div
                  key={device.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{device.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {device.platform} · {device.lastSeenAt ? `last seen ${formatRelative(device.lastSeenAt)}` : 'never seen'}
                    </p>
                  </div>
                  <StatusBadge status={device.status} />
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

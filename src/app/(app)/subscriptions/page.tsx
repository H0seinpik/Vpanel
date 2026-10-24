'use client';

import * as React from 'react';
import { CreditCard, Plus, RefreshCw } from 'lucide-react';
import { api, ApiError, toQuery } from '@/lib/api-client';
import { useApi } from '@/hooks/use-api';
import { formatBytes, formatCurrency, formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton, EmptyState } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { Pagination, type PaginationMeta } from '@/components/common/pagination';
import { Tabs, TabsContent, TabsList, TabsTrigger, UsageBar } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  trafficLimitBytes: number | null;
  durationDays: number;
  deviceLimit: number;
  allowedProtocols: string[];
  status: string;
  isDefault: boolean;
  _count?: { subscriptions: number };
}

interface SubscriptionRow {
  id: string;
  userId: string;
  quotaType: string;
  trafficLimitBytes: number | null;
  trafficUsedBytes: number;
  startsAt: string;
  endsAt: string | null;
  status: string;
  plan: { id: string; name: string } | null;
  server: { id: string; name: string } | null;
  user?: { username: string; displayName: string | null };
}

interface SubscriptionsResponse {
  data: SubscriptionRow[];
  pagination: PaginationMeta;
}

/** Plans catalog plus the subscriptions built from them. */
export default function SubscriptionsPage() {
  const toast = useToast();
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const plans = useApi<PlanRow[]>('/api/plans');
  const subscriptions = useApi<SubscriptionsResponse>(
    `/api/subscriptions${toQuery({ page, pageSize })}`,
  );
  const users = useApi<{ data: Array<{ id: string; username: string; displayName: string | null }> }>(
    '/api/users?pageSize=200',
  );
  const servers = useApi<{ data: Array<{ id: string; name: string }> }>('/api/servers?pageSize=100');

  const [createOpen, setCreateOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [form, setForm] = React.useState({ userId: '', planId: '', serverId: '', durationDays: '30' });

  async function createSubscription() {
    if (!form.userId) return;
    setCreating(true);
    try {
      await api.post('/api/subscriptions', {
        userId: form.userId,
        planId: form.planId || null,
        serverId: form.serverId || null,
        durationDays: form.durationDays ? Number(form.durationDays) : 30,
      });
      toast.success('Subscription created');
      setCreateOpen(false);
      setForm({ userId: '', planId: '', serverId: '', durationDays: '30' });
      await subscriptions.reload();
    } catch (caught) {
      toast.error('Could not create subscription', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subscriptions"
        description="Reusable plans and the subscriptions assigned to users."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void subscriptions.reload()}
              loading={subscriptions.refreshing}
            >
              <RefreshCw /> Refresh
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> New subscription
            </Button>
          </>
        }
      />

      <Tabs defaultValue="subscriptions">
        <TabsList>
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          <TabsTrigger value="plans">Plans</TabsTrigger>
        </TabsList>

        <TabsContent value="subscriptions">
          <Card className="overflow-hidden">
            {subscriptions.loading && !subscriptions.data ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-12" />
                ))}
              </div>
            ) : (subscriptions.data?.data.length ?? 0) === 0 ? (
              <EmptyState
                icon={CreditCard}
                title="No subscriptions yet"
                description="Create a subscription to bind a user to a plan and a validity window."
                action={
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus /> New subscription
                  </Button>
                }
              />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Server</TableHead>
                      <TableHead className="w-[180px]">Traffic</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {subscriptions.data?.data.map((subscription) => {
                      const unlimited = subscription.trafficLimitBytes === null;
                      const percent = unlimited
                        ? 0
                        : Math.min(
                            100,
                            (subscription.trafficUsedBytes / (subscription.trafficLimitBytes || 1)) * 100,
                          );
                      return (
                        <TableRow key={subscription.id}>
                          <TableCell className="font-medium">
                            {subscription.user?.displayName ??
                              subscription.user?.username ??
                              subscription.userId}
                          </TableCell>
                          <TableCell className="text-sm">{subscription.plan?.name ?? 'Custom'}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {subscription.server?.name ?? 'Any'}
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <UsageBar percent={percent} />
                              <p className="text-[11px] tabular-nums text-muted-foreground">
                                {formatBytes(subscription.trafficUsedBytes)} /{' '}
                                {unlimited ? 'unlimited' : formatBytes(subscription.trafficLimitBytes)}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatDate(subscription.startsAt)} →{' '}
                            {subscription.endsAt ? formatDate(subscription.endsAt) : '∞'}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={subscription.status} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                {subscriptions.data ? (
                  <Pagination
                    meta={subscriptions.data.pagination}
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
        </TabsContent>

        <TabsContent value="plans">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(plans.data ?? []).map((plan) => (
              <Card key={plan.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>{plan.name}</CardTitle>
                    {plan.isDefault ? <StatusBadge status="INFO" label="Default" /> : null}
                  </div>
                  <CardDescription>{plan.description ?? 'No description'}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-2xl font-semibold">
                    {formatCurrency(plan.priceCents, plan.currency)}
                    <span className="text-sm font-normal text-muted-foreground">
                      {' '}
                      / {plan.durationDays} days
                    </span>
                  </p>
                  <ul className="space-y-1 text-muted-foreground">
                    <li>
                      Traffic:{' '}
                      <span className="font-medium text-foreground">
                        {plan.trafficLimitBytes === null ? 'Unlimited' : formatBytes(plan.trafficLimitBytes)}
                      </span>
                    </li>
                    <li>
                      Devices: <span className="font-medium text-foreground">{plan.deviceLimit}</span>
                    </li>
                    <li>
                      Protocols:{' '}
                      <span className="font-medium text-foreground">
                        {plan.allowedProtocols.join(', ')}
                      </span>
                    </li>
                    <li>
                      Subscribers:{' '}
                      <span className="font-medium text-foreground">{plan._count?.subscriptions ?? 0}</span>
                    </li>
                  </ul>
                  <StatusBadge status={plan.status} />
                </CardContent>
              </Card>
            ))}
            {plans.loading ? (
              <>
                <Skeleton className="h-56" />
                <Skeleton className="h-56" />
                <Skeleton className="h-56" />
              </>
            ) : null}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New subscription</DialogTitle>
            <DialogDescription>
              Binds a user to a plan and sets their validity window. Plan values are copied onto the
              subscription.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>User</Label>
              <Select value={form.userId} onValueChange={(value) => setForm((c) => ({ ...c, userId: value }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a user" />
                </SelectTrigger>
                <SelectContent>
                  {(users.data?.data ?? []).map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.displayName ?? user.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Plan</Label>
              <Select
                value={form.planId || 'none'}
                onValueChange={(value) => setForm((c) => ({ ...c, planId: value === 'none' ? '' : value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Custom" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Custom (no plan)</SelectItem>
                  {(plans.data ?? []).map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Server (optional)</Label>
              <Select
                value={form.serverId || 'any'}
                onValueChange={(value) =>
                  setForm((c) => ({ ...c, serverId: value === 'any' ? '' : value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Any server" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any server</SelectItem>
                  {(servers.data?.data ?? []).map((server) => (
                    <SelectItem key={server.id} value={server.id}>
                      {server.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Duration (days)</Label>
              <Input
                type="number"
                min={1}
                value={form.durationDays}
                onChange={(event) => setForm((c) => ({ ...c, durationDays: event.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createSubscription()} loading={creating} disabled={!form.userId}>
              Create subscription
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

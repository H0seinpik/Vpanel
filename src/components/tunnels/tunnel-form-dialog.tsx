'use client';

import * as React from 'react';
import { ArrowRight, Waypoints } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import type { TunnelNetwork, TunnelRow, TunnelServer } from './types';

const NETWORK_LABEL: Record<TunnelNetwork, string> = {
  TCP: 'TCP',
  UDP: 'UDP',
  TCP_UDP: 'TCP + UDP',
};

function describeError(caught: unknown): string {
  if (caught instanceof ApiError) {
    const details = caught.details;
    if (Array.isArray(details) && details.length > 0) {
      const first = details[0] as { path?: unknown[]; message?: string };
      const path = Array.isArray(first.path) && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
      return `${path}${first.message ?? caught.message}`;
    }
    return caught.message;
  }
  return caught instanceof Error ? caught.message : 'Something went wrong';
}

/**
 * Create / edit dialog for a port-forwarding tunnel.
 *
 * It deliberately looks like the configuration wizard rather than a raw JSON
 * editor: the operator picks a server, a public port and a destination, and the
 * server-side service owns all of the conflict checks.
 */
export function TunnelFormDialog({
  open,
  onOpenChange,
  tunnel,
  servers,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tunnel: TunnelRow | null;
  servers: TunnelServer[];
  onSaved: () => void | Promise<void>;
}) {
  const { success, error: toastError } = useToast();
  const editing = Boolean(tunnel);

  const [name, setName] = React.useState('');
  const [serverId, setServerId] = React.useState('');
  const [listenAddress, setListenAddress] = React.useState('0.0.0.0');
  const [listenPort, setListenPort] = React.useState('8443');
  const [targetHost, setTargetHost] = React.useState('');
  const [targetPort, setTargetPort] = React.useState('443');
  const [network, setNetwork] = React.useState<TunnelNetwork>('TCP');
  const [enabled, setEnabled] = React.useState(true);
  const [notes, setNotes] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // Reset the form every time the dialog opens, or the row being edited changes.
  React.useEffect(() => {
    if (!open) return;

    setName(tunnel?.name ?? '');
    setServerId(tunnel?.serverId ?? servers[0]?.id ?? '');
    setListenAddress(tunnel?.listenAddress ?? '0.0.0.0');
    setListenPort(tunnel ? String(tunnel.listenPort) : '8443');
    setTargetHost(tunnel?.targetHost ?? '');
    setTargetPort(tunnel ? String(tunnel.targetPort) : '443');
    setNetwork(tunnel?.network ?? 'TCP');
    setEnabled(tunnel?.enabled ?? true);
    setNotes(tunnel?.notes ?? '');
    setFormError(null);
    setSaving(false);
    // `servers` is intentionally not a dependency: it only supplies the default
    // for a brand-new tunnel, and re-running on every list refresh would wipe
    // whatever the operator has typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tunnel]);

  // If the server list arrives after the dialog opened, fill the empty choice.
  React.useEffect(() => {
    if (!open || editing || serverId || servers.length === 0) return;
    setServerId(servers[0].id);
  }, [open, editing, serverId, servers]);

  const networkLabel = NETWORK_LABEL[network];
  const listenPreview = `${listenAddress.trim() || '0.0.0.0'}:${listenPort.trim() || '—'}`;
  const targetPreview = `${targetHost.trim() || 'destination'}:${targetPort.trim() || '—'}`;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (!name.trim()) {
      setFormError('Give the tunnel a name.');
      return;
    }
    if (!serverId) {
      setFormError('Select a server.');
      return;
    }
    if (!targetHost.trim()) {
      setFormError('Enter the destination host.');
      return;
    }

    const payload = {
      name: name.trim(),
      serverId,
      listenAddress: listenAddress.trim() || '0.0.0.0',
      listenPort: Number(listenPort),
      targetHost: targetHost.trim(),
      targetPort: Number(targetPort),
      network,
      enabled,
      ...(notes.trim() ? { notes: notes.trim() } : editing ? { notes: null } : {}),
    };

    setSaving(true);
    try {
      if (tunnel) {
        await api.patch(`/api/tunnels/${tunnel.id}`, payload);
        success('Tunnel updated', 'The node will apply the change on its next reconcile.');
      } else {
        await api.post('/api/tunnels', payload);
        success('Tunnel created', 'The node will start forwarding on its next reconcile.');
      }

      await onSaved();
      onOpenChange(false);
    } catch (caught) {
      const message = describeError(caught);
      setFormError(message);
      toastError(editing ? 'Could not update tunnel' : 'Could not create tunnel', message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Waypoints className="size-4" />
            </span>
            {editing ? 'Edit tunnel' : 'New tunnel'}
          </DialogTitle>
          <DialogDescription>
            Forward a port on this node to another host. Xray&apos;s tunnel protocol has no
            users or passwords — it simply passes traffic through.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="tunnel-name">Name</Label>
            <Input
              id="tunnel-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Germany relay"
              autoFocus
              maxLength={120}
            />
            <p className="text-xs text-muted-foreground">
              Only used inside the panel; clients never see it.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tunnel-server">Server</Label>
            <Select value={serverId} onValueChange={setServerId}>
              <SelectTrigger id="tunnel-server">
                <SelectValue placeholder="Select a server" />
              </SelectTrigger>
              <SelectContent>
                {servers.map((server) => (
                  <SelectItem key={server.id} value={server.id}>
                    {server.name} — {server.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {servers.length === 0 ? (
              <p className="text-xs text-warning">
                Register a server first. A tunnel has to belong to a node.
              </p>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="tunnel-listen-address">Listen address</Label>
              <Input
                id="tunnel-listen-address"
                value={listenAddress}
                onChange={(event) => setListenAddress(event.target.value)}
                placeholder="0.0.0.0"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tunnel-listen-port">Listen port</Label>
              <Input
                id="tunnel-listen-port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={listenPort}
                onChange={(event) => setListenPort(event.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="tunnel-target-host">Destination host</Label>
              <Input
                id="tunnel-target-host"
                value={targetHost}
                onChange={(event) => setTargetHost(event.target.value)}
                placeholder="e.g. 203.0.113.10 or relay.example.com"
                spellCheck={false}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tunnel-target-port">Destination port</Label>
              <Input
                id="tunnel-target-port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={targetPort}
                onChange={(event) => setTargetPort(event.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tunnel-network">Transport</Label>
              <Select
                value={network}
                onValueChange={(value) => setNetwork(value as TunnelNetwork)}
              >
                <SelectTrigger id="tunnel-network">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="TCP">TCP only</SelectItem>
                  <SelectItem value="UDP">UDP only</SelectItem>
                  <SelectItem value="TCP_UDP">TCP + UDP</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tunnel-enabled">State</Label>
              <div className="flex h-9 items-center justify-between rounded-md border border-input bg-card px-3">
                <span className="text-sm text-muted-foreground">
                  {enabled ? 'Enabled' : 'Disabled'}
                </span>
                <Switch
                  id="tunnel-enabled"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  aria-label="Enable tunnel"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tunnel-notes">Notes</Label>
            <Textarea
              id="tunnel-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional — what is this tunnel for?"
              maxLength={500}
              rows={2}
            />
          </div>

          <div className="rounded-lg border border-border bg-muted/35 p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Preview
            </p>
            <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
              <span className="rounded bg-background px-2 py-1">{listenPreview}</span>
              <ArrowRight className="size-4 text-muted-foreground" />
              <span className="rounded bg-background px-2 py-1">{targetPreview}</span>
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                {networkLabel}
              </span>
            </div>
          </div>

          {tunnel?.lastError ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              Last reconcile error: {tunnel.lastError}
            </div>
          ) : null}

          {formError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {formError}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={servers.length === 0}>
              {editing ? 'Save changes' : 'Create tunnel'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

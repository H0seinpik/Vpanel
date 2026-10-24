'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Info, Save } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/common/page-header';
import { useToast } from '@/components/ui/toast';

/**
 * Register a new server.
 *
 * Only servers added here are ever contacted by the panel. The optional agent
 * endpoint/token are stored encrypted at rest and are never returned by the API.
 */
export default function NewServerPage() {
  const router = useRouter();
  const toast = useToast();

  const [form, setForm] = React.useState({
    name: '',
    hostname: '',
    ipAddress: '',
    port: '443',
    protocol: 'VLESS',
    type: 'XRAY',
    location: '',
    description: '',
    monitoringEnabled: true,
    agentEndpoint: '',
    agentToken: '',
  });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = 'A name is required.';
    if (!form.hostname.trim()) next.hostname = 'A hostname is required.';
    if (!form.ipAddress.trim()) next.ipAddress = 'An IP address or hostname is required.';
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) next.port = 'Port must be 1–65535.';
    if (form.agentEndpoint && !/^https?:\/\//.test(form.agentEndpoint)) {
      next.agentEndpoint = 'The agent endpoint must start with http:// or https://';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!validate()) return;

    setSaving(true);
    try {
      const created = await api.post<{ id: string; name: string }>('/api/servers', {
        name: form.name,
        hostname: form.hostname,
        ipAddress: form.ipAddress,
        port: Number(form.port),
        protocol: form.protocol,
        type: form.type,
        location: form.location || undefined,
        description: form.description || undefined,
        monitoringEnabled: form.monitoringEnabled,
        agentEndpoint: form.agentEndpoint || undefined,
        agentToken: form.agentToken || undefined,
      });

      toast.success('Server registered', `"${created.name}" was added. Test the connection to verify it.`);
      router.push(`/servers/${created.id}`);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'Could not save the server.';
      toast.error('Registration failed', message);
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Add server"
        description="Register a node you control so it can be monitored and used for configurations."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/servers">
              <ArrowLeft /> Back to servers
            </Link>
          </Button>
        }
      />

      <form onSubmit={onSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Basic information</CardTitle>
            <CardDescription>How this node is identified in the panel.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required error={errors.name} className="sm:col-span-2">
              <Input
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
                placeholder="Germany Node 01"
                autoFocus
              />
            </Field>

            <Field label="Hostname" required error={errors.hostname} help="Public DNS name used in client configurations.">
              <Input
                value={form.hostname}
                onChange={(event) => update('hostname', event.target.value)}
                placeholder="node01.example.com"
              />
            </Field>

            <Field label="IP address" required error={errors.ipAddress} help="Used for monitoring and heartbeat checks.">
              <Input
                value={form.ipAddress}
                onChange={(event) => update('ipAddress', event.target.value)}
                placeholder="203.0.113.10"
              />
            </Field>

            <Field label="Port" required error={errors.port}>
              <Input
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(event) => update('port', event.target.value)}
              />
            </Field>

            <Field label="Location" help="Shown to users, e.g. “Frankfurt, DE”.">
              <Input
                value={form.location}
                onChange={(event) => update('location', event.target.value)}
                placeholder="Frankfurt, DE"
              />
            </Field>

            <Field label="Node type">
              <Select value={form.type} onValueChange={(value) => update('type', value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="XRAY">Xray</SelectItem>
                  <SelectItem value="V2RAY">V2Ray</SelectItem>
                  <SelectItem value="GENERIC">Generic proxy node</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label="Default protocol">
              <Select value={form.protocol} onValueChange={(value) => update('protocol', value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="VLESS">VLESS</SelectItem>
                  <SelectItem value="VMESS">VMess</SelectItem>
                  <SelectItem value="TROJAN">Trojan</SelectItem>
                  <SelectItem value="SHADOWSOCKS">Shadowsocks</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label="Description" className="sm:col-span-2">
              <Textarea
                value={form.description}
                onChange={(event) => update('description', event.target.value)}
                placeholder="Optional notes about this node, provider, capacity…"
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Monitoring & agent</CardTitle>
            <CardDescription>
              The panel only ever contacts this host. Leave the agent fields blank to use the built-in
              local provider.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center justify-between rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium">Enable monitoring</p>
                <p className="text-xs text-muted-foreground">
                  Poll status, CPU, RAM and connection counts on every monitoring interval.
                </p>
              </div>
              <Switch
                checked={form.monitoringEnabled}
                onCheckedChange={(value) => update('monitoringEnabled', value)}
              />
            </label>

            <Field
              label="Agent endpoint"
              error={errors.agentEndpoint}
              help="Base URL of the VPanel agent on this node, e.g. https://node01.example.com:8443"
            >
              <Input
                value={form.agentEndpoint}
                onChange={(event) => update('agentEndpoint', event.target.value)}
                placeholder="https://node01.example.com:8443"
              />
            </Field>

            <Field
              label="Agent token"
              help="Stored encrypted at rest. It is never returned by the API or shown in the UI again."
            >
              <Input
                type="password"
                value={form.agentToken}
                onChange={(event) => update('agentToken', event.target.value)}
                placeholder="Paste the token issued by the agent"
              />
            </Field>

            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <p>
                Credentials are encrypted with AES-256-GCM using a key derived from your server
                secret. They are never stored in plaintext and never exposed to the browser.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/servers">Cancel</Link>
          </Button>
          <Button type="submit" loading={saving}>
            <Save /> Register server
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  required,
  error,
  help,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  help?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      <Label>
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {help && !error ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

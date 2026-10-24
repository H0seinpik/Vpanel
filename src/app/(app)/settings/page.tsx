'use client';

import * as React from 'react';
import { AlertTriangle, Save, ShieldAlert } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useApi } from '@/hooks/use-api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger, Switch } from '@/components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { useToast } from '@/components/ui/toast';

interface Settings {
  general: {
    appName: string;
    logoUrl: string | null;
    defaultTrafficLimitGb: number | null;
    defaultExpirationDays: number;
    monitoringIntervalSeconds: number;
    trafficWarnPercent: number;
    trafficCriticalPercent: number;
    notificationEmailEnabled: boolean;
    notificationWebhookUrl: string | null;
    allowUserSelfService: boolean;
    registrationEnabled: boolean;
  };
  security: {
    sessionTimeoutMinutes: number;
    passwordMinLength: number;
    requireMfa: boolean;
    maxLoginAttempts: number;
    ipAllowlist: string[];
    forceHttps: boolean;
  };
  server: {
    defaultPort: number;
    defaultProtocol: string;
    heartbeatTimeoutSeconds: number;
    allowSelfSignedAgent: boolean;
  };
  traffic: {
    countingMode: 'server' | 'config' | 'user';
    resetPeriod: 'never' | 'monthly' | 'custom';
    resetDayOfMonth: number;
    autoSuspendOnExceed: boolean;
  };
  branding: {
    primaryColor: string;
    accentColor: string;
    footerText: string;
    supportUrl: string | null;
  };
}

/**
 * Admin settings.
 *
 * The security tab is only writable by administrators — the API rejects an
 * OPERATOR attempting it, and the tab is hidden from them here too.
 */
export default function SettingsPage() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<Settings>('/api/settings');
  const me = useApi<{ user: { role: string } }>('/api/auth/me');

  const [form, setForm] = React.useState<Settings | null>(null);
  const [saving, setSaving] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const isAdmin = me.data?.user.role === 'ADMIN';

  async function save(category: keyof Settings) {
    if (!form) return;
    setSaving(category);
    try {
      await api.patch('/api/settings', { [category]: form[category] });
      toast.success('Settings saved', `${category} configuration updated.`);
      await reload();
    } catch (caught) {
      toast.error('Save failed', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(null);
    }
  }

  if (loading && !form) {
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" />
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !form) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <AlertTriangle className="size-6 text-destructive" />
          <p className="text-sm font-medium">Could not load settings</p>
          <p className="text-sm text-muted-foreground">{error?.message}</p>
          <Button onClick={() => void reload()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Application defaults, security policy and notification thresholds."
      />

      <Tabs defaultValue="general">
        <TabsList className="flex-wrap">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="traffic">Traffic</TabsTrigger>
          <TabsTrigger value="server">Servers</TabsTrigger>
          {isAdmin ? <TabsTrigger value="security">Security</TabsTrigger> : null}
          <TabsTrigger value="branding">Branding</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
        </TabsList>

        {/* General */}
        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle>General settings</CardTitle>
              <CardDescription>Defaults applied to new accounts and the dashboard.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Application name">
                <Input
                  value={form.general.appName}
                  onChange={(event) =>
                    setForm({ ...form, general: { ...form.general, appName: event.target.value } })
                  }
                />
              </Field>

              <Field label="Logo URL" help="Optional. Used on the login page and sidebar.">
                <Input
                  value={form.general.logoUrl ?? ''}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      general: { ...form.general, logoUrl: event.target.value || null },
                    })
                  }
                  placeholder="https://example.com/logo.png"
                />
              </Field>

              <Field label="Default traffic limit (GB)" help="Blank = unlimited.">
                <Input
                  type="number"
                  min={0}
                  value={form.general.defaultTrafficLimitGb ?? ''}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      general: {
                        ...form.general,
                        defaultTrafficLimitGb: event.target.value === '' ? null : Number(event.target.value),
                      },
                    })
                  }
                />
              </Field>

              <Field label="Default expiration (days)">
                <Input
                  type="number"
                  min={1}
                  value={form.general.defaultExpirationDays}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      general: { ...form.general, defaultExpirationDays: Number(event.target.value) },
                    })
                  }
                />
              </Field>

              <Field label="Monitoring interval (seconds)">
                <Input
                  type="number"
                  min={10}
                  max={3600}
                  value={form.general.monitoringIntervalSeconds}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      general: { ...form.general, monitoringIntervalSeconds: Number(event.target.value) },
                    })
                  }
                />
              </Field>

              <ToggleField
                label="Allow user self-service"
                description="Let users register their own devices and view their configurations."
                checked={form.general.allowUserSelfService}
                onChange={(checked) =>
                  setForm({ ...form, general: { ...form.general, allowUserSelfService: checked } })
                }
              />

              <ToggleField
                label="Public registration"
                description="Off by default — accounts should be created by an administrator."
                checked={form.general.registrationEnabled}
                onChange={(checked) =>
                  setForm({ ...form, general: { ...form.general, registrationEnabled: checked } })
                }
              />

              <div className="flex justify-end sm:col-span-2">
                <Button onClick={() => void save('general')} loading={saving === 'general'}>
                  <Save /> Save general settings
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Traffic */}
        <TabsContent value="traffic">
          <Card>
            <CardHeader>
              <CardTitle>Traffic accounting</CardTitle>
              <CardDescription>
                How usage is attributed and when quotas reset. Enforced by the background worker.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Counting mode">
                <Select
                  value={form.traffic.countingMode}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      traffic: { ...form.traffic, countingMode: value as Settings['traffic']['countingMode'] },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="server">Per server</SelectItem>
                    <SelectItem value="config">Per configuration</SelectItem>
                    <SelectItem value="user">Per user</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Reset period">
                <Select
                  value={form.traffic.resetPeriod}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      traffic: { ...form.traffic, resetPeriod: value as Settings['traffic']['resetPeriod'] },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="never">Never (total quota)</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="custom">Custom day of month</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Reset day of month">
                <Input
                  type="number"
                  min={1}
                  max={28}
                  value={form.traffic.resetDayOfMonth}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      traffic: { ...form.traffic, resetDayOfMonth: Number(event.target.value) },
                    })
                  }
                />
              </Field>

              <ToggleField
                label="Auto-suspend when quota is exceeded"
                description="Automatically move accounts past their limit to TRAFFIC_EXCEEDED and disable their assignments."
                checked={form.traffic.autoSuspendOnExceed}
                onChange={(checked) =>
                  setForm({ ...form, traffic: { ...form.traffic, autoSuspendOnExceed: checked } })
                }
              />

              <div className="flex justify-end sm:col-span-2">
                <Button onClick={() => void save('traffic')} loading={saving === 'traffic'}>
                  <Save /> Save traffic settings
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Servers */}
        <TabsContent value="server">
          <Card>
            <CardHeader>
              <CardTitle>Server defaults</CardTitle>
              <CardDescription>Applied when registering a new node.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Default port">
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.server.defaultPort}
                  onChange={(event) =>
                    setForm({ ...form, server: { ...form.server, defaultPort: Number(event.target.value) } })
                  }
                />
              </Field>

              <Field label="Default protocol">
                <Select
                  value={form.server.defaultProtocol}
                  onValueChange={(value) => setForm({ ...form, server: { ...form.server, defaultProtocol: value } })}
                >
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

              <Field
                label="Heartbeat timeout (seconds)"
                help="A server with no heartbeat within this window is marked offline."
              >
                <Input
                  type="number"
                  min={10}
                  value={form.server.heartbeatTimeoutSeconds}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      server: { ...form.server, heartbeatTimeoutSeconds: Number(event.target.value) },
                    })
                  }
                />
              </Field>

              <ToggleField
                label="Allow self-signed agent certificates"
                description="Only enable on a trusted private network."
                checked={form.server.allowSelfSignedAgent}
                onChange={(checked) =>
                  setForm({ ...form, server: { ...form.server, allowSelfSignedAgent: checked } })
                }
              />

              <div className="flex justify-end sm:col-span-2">
                <Button onClick={() => void save('server')} loading={saving === 'server'}>
                  <Save /> Save server settings
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Security (admin only) */}
        {isAdmin ? (
          <TabsContent value="security">
            <Card className="border-warning/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldAlert className="size-4 text-warning" /> Security settings
                </CardTitle>
                <CardDescription>
                  Administrator-only. These values affect authentication and session handling.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field label="Session timeout (minutes)">
                  <Input
                    type="number"
                    min={5}
                    max={10080}
                    value={form.security.sessionTimeoutMinutes}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        security: { ...form.security, sessionTimeoutMinutes: Number(event.target.value) },
                      })
                    }
                  />
                </Field>

                <Field label="Minimum password length">
                  <Input
                    type="number"
                    min={8}
                    max={128}
                    value={form.security.passwordMinLength}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        security: { ...form.security, passwordMinLength: Number(event.target.value) },
                      })
                    }
                  />
                </Field>

                <Field label="Max login attempts" help="Used by the login rate limiter.">
                  <Input
                    type="number"
                    min={3}
                    max={50}
                    value={form.security.maxLoginAttempts}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        security: { ...form.security, maxLoginAttempts: Number(event.target.value) },
                      })
                    }
                  />
                </Field>

                <Field label="IP allowlist" help="One entry per line. Empty = allow all.">
                  <textarea
                    value={form.security.ipAllowlist.join('\n')}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        security: {
                          ...form.security,
                          ipAllowlist: event.target.value
                            .split('\n')
                            .map((line) => line.trim())
                            .filter(Boolean),
                        },
                      })
                    }
                    rows={4}
                    className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
                  />
                </Field>

                <ToggleField
                  label="Require multi-factor authentication"
                  description="Reserved for the MFA integration; currently informational."
                  checked={form.security.requireMfa}
                  onChange={(checked) => setForm({ ...form, security: { ...form.security, requireMfa: checked } })}
                />

                <ToggleField
                  label="Force HTTPS"
                  description="Sets secure cookie flags and HSTS at the reverse proxy."
                  checked={form.security.forceHttps}
                  onChange={(checked) => setForm({ ...form, security: { ...form.security, forceHttps: checked } })}
                />

                <div className="flex justify-end sm:col-span-2">
                  <Button onClick={() => void save('security')} loading={saving === 'security'}>
                    <Save /> Save security settings
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        ) : null}

        {/* Branding */}
        <TabsContent value="branding">
          <Card>
            <CardHeader>
              <CardTitle>Branding</CardTitle>
              <CardDescription>Colours and copy shown to your users.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Primary colour">
                <Input
                  value={form.branding.primaryColor}
                  onChange={(event) =>
                    setForm({ ...form, branding: { ...form.branding, primaryColor: event.target.value } })
                  }
                  placeholder="#4f46e5"
                />
              </Field>

              <Field label="Accent colour">
                <Input
                  value={form.branding.accentColor}
                  onChange={(event) =>
                    setForm({ ...form, branding: { ...form.branding, accentColor: event.target.value } })
                  }
                  placeholder="#0ea5e9"
                />
              </Field>

              <Field label="Support URL">
                <Input
                  value={form.branding.supportUrl ?? ''}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      branding: { ...form.branding, supportUrl: event.target.value || null },
                    })
                  }
                  placeholder="https://support.example.com"
                />
              </Field>

              <Field label="Footer text">
                <Input
                  value={form.branding.footerText}
                  onChange={(event) =>
                    setForm({ ...form, branding: { ...form.branding, footerText: event.target.value } })
                  }
                  placeholder="© 2026 Example Ltd"
                />
              </Field>

              <div className="flex justify-end sm:col-span-2">
                <Button onClick={() => void save('branding')} loading={saving === 'branding'}>
                  <Save /> Save branding
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notifications */}
        <TabsContent value="notifications">
          <Card>
            <CardHeader>
              <CardTitle>Notification thresholds</CardTitle>
              <CardDescription>
                When usage and expiry warnings are raised. Delivery channels can be added later.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Warning threshold (%)">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={form.general.trafficWarnPercent}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      general: { ...form.general, trafficWarnPercent: Number(event.target.value) },
                    })
                  }
                />
              </Field>

              <Field label="Critical threshold (%)">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={form.general.trafficCriticalPercent}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      general: { ...form.general, trafficCriticalPercent: Number(event.target.value) },
                    })
                  }
                />
              </Field>

              <Field label="Webhook URL" help="Optional. Receives a JSON POST for every alert.">
                <Input
                  value={form.general.notificationWebhookUrl ?? ''}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      general: { ...form.general, notificationWebhookUrl: event.target.value || null },
                    })
                  }
                  placeholder="https://hooks.example.com/vpanel"
                />
              </Field>

              <ToggleField
                label="Email notifications"
                description="Requires SMTP_URL to be configured in the environment."
                checked={form.general.notificationEmailEnabled}
                onChange={(checked) =>
                  setForm({ ...form, general: { ...form.general, notificationEmailEnabled: checked } })
                }
              />

              <div className="flex justify-end sm:col-span-2">
                <Button onClick={() => void save('general')} loading={saving === 'general'}>
                  <Save /> Save notification settings
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

function ToggleField({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

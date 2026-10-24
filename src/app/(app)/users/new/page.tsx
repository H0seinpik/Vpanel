'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, Wand2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { useApi } from '@/hooks/use-api';
import { formatBytes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/common/page-header';
import { useToast } from '@/components/ui/toast';

interface PlanRow {
  id: string;
  name: string;
  trafficLimitBytes: number | null;
  durationDays: number;
  deviceLimit: number;
}

const TRAFFIC_PRESETS = [
  { label: 'Unlimited', value: '' },
  { label: '10 GB', value: '10' },
  { label: '50 GB', value: '50' },
  { label: '100 GB', value: '100' },
  { label: '500 GB', value: '500' },
];

const EXPIRY_PRESETS = [
  { label: '7 days', value: '7' },
  { label: '30 days', value: '30' },
  { label: '90 days', value: '90' },
  { label: '365 days', value: '365' },
];

/** Generate a strong random password the admin can hand to the user. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const symbols = '!@#$%^&*';
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  let password = '';
  for (let index = 0; index < 14; index += 1) {
    password += alphabet[bytes[index]! % alphabet.length];
  }
  password += symbols[bytes[14]! % symbols.length];
  password += String(bytes[15]! % 10);
  return password;
}

/**
 * Create a user.
 *
 * Quota and expiry can be taken from a plan or set explicitly; leaving both
 * blank falls back to the system defaults configured in Settings.
 */
export default function NewUserPage() {
  const router = useRouter();
  const toast = useToast();

  const { data: plans } = useApi<PlanRow[]>('/api/plans?status=ACTIVE');

  const [form, setForm] = React.useState({
    username: '',
    displayName: '',
    email: '',
    password: '',
    role: 'USER',
    status: 'ACTIVE',
    planId: '',
    trafficLimitGb: '',
    expirationDays: '30',
    notes: '',
  });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!form.username.trim()) next.username = 'A username is required.';
    else if (!/^[a-zA-Z0-9._-]{3,}$/.test(form.username))
      next.username = 'Use at least 3 characters: letters, numbers, dot, dash or underscore.';
    if (!form.email.trim()) next.email = 'An email address is required.';
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) next.email = 'Enter a valid email address.';
    if (form.password.length < 8) next.password = 'Use at least 8 characters.';
    else if (!/[a-z]/.test(form.password) || !/[A-Z]/.test(form.password) || !/[0-9]/.test(form.password))
      next.password = 'Include upper case, lower case and a number.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!validate()) return;

    setSaving(true);
    try {
      const created = await api.post<{ id: string; username: string }>('/api/users', {
        username: form.username,
        displayName: form.displayName || undefined,
        email: form.email,
        password: form.password,
        role: form.role,
        status: form.status,
        planId: form.planId || null,
        trafficLimitGb: form.trafficLimitGb === '' ? null : Number(form.trafficLimitGb),
        expirationDays: form.expirationDays ? Number(form.expirationDays) : null,
        notes: form.notes || undefined,
      });

      toast.success('User created', `${created.username} can now sign in.`);
      router.push(`/users/${created.id}`);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'Could not create the user.';
      toast.error('Creation failed', message);
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Create user"
        description="Accounts you create here can sign in and receive configurations."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/users">
              <ArrowLeft /> Back to users
            </Link>
          </Button>
        }
      />

      <form onSubmit={onSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>Identity and access level.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Username" required error={errors.username}>
              <Input
                value={form.username}
                onChange={(event) => update('username', event.target.value)}
                placeholder="jdoe"
                autoFocus
              />
            </Field>

            <Field label="Display name">
              <Input
                value={form.displayName}
                onChange={(event) => update('displayName', event.target.value)}
                placeholder="John Doe"
              />
            </Field>

            <Field label="Email" required error={errors.email} className="sm:col-span-2">
              <Input
                type="email"
                value={form.email}
                onChange={(event) => update('email', event.target.value)}
                placeholder="jdoe@example.com"
              />
            </Field>

            <Field label="Password" required error={errors.password} className="sm:col-span-2">
              <div className="flex gap-2">
                <Input
                  type="text"
                  value={form.password}
                  onChange={(event) => update('password', event.target.value)}
                  placeholder="Minimum 8 characters, mixed case and a number"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => update('password', generatePassword())}
                >
                  <Wand2 /> Generate
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Stored as a bcrypt hash. Give it to the user over a secure channel.
              </p>
            </Field>

            <Field label="Role" help="Operators manage day-to-day resources but cannot change security settings.">
              <Select value={form.role} onValueChange={(value) => update('role', value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">User</SelectItem>
                  <SelectItem value="OPERATOR">Operator</SelectItem>
                  <SelectItem value="ADMIN">Administrator</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label="Status">
              <Select value={form.status} onValueChange={(value) => update('status', value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="SUSPENDED">Suspended</SelectItem>
                  <SelectItem value="DISABLED">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Plan, quota and expiry</CardTitle>
            <CardDescription>
              Pick a plan, or set a custom allowance. Leave the traffic limit blank for unlimited.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Plan" className="sm:col-span-2">
              <Select value={form.planId || 'none'} onValueChange={(value) => update('planId', value === 'none' ? '' : value)}>
                <SelectTrigger>
                  <SelectValue placeholder="No plan" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No plan (custom)</SelectItem>
                  {(plans ?? []).map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name} — {plan.trafficLimitBytes === null ? 'Unlimited' : formatBytes(plan.trafficLimitBytes)} /{' '}
                      {plan.durationDays}d
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Traffic limit (GB)" help="Blank = unlimited.">
              <Input
                type="number"
                min={0}
                value={form.trafficLimitGb}
                onChange={(event) => update('trafficLimitGb', event.target.value)}
                placeholder="100"
              />
              <div className="flex flex-wrap gap-1 pt-1">
                {TRAFFIC_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => update('trafficLimitGb', preset.value)}
                    className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Expires in (days)">
              <Input
                type="number"
                min={1}
                value={form.expirationDays}
                onChange={(event) => update('expirationDays', event.target.value)}
              />
              <div className="flex flex-wrap gap-1 pt-1">
                {EXPIRY_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => update('expirationDays', preset.value)}
                    className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Notes" className="sm:col-span-2">
              <Textarea
                value={form.notes}
                onChange={(event) => update('notes', event.target.value)}
                placeholder="Internal notes about this account…"
              />
            </Field>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/users">Cancel</Link>
          </Button>
          <Button type="submit" loading={saving}>
            <Save /> Create user
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

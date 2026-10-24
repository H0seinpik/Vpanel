'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Download,
  QrCode,
  Server as ServerIcon,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Users as UsersIcon,
  Wand2,
} from 'lucide-react';
import { api, ApiError, copyToClipboard, downloadFile } from '@/lib/api-client';
import { useApi } from '@/hooks/use-api';
import { formatBytes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/badge';
import { Checkbox, Switch } from '@/components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/common/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { claimedPorts, staticPortConflict, suggestPort } from '@/services/port-conflicts';
import { shareIneligible } from '@/services/port-sharing';
import { shareDefaults } from '@/services/sharing-defaults';
import type { CertificateStatus } from '@/server/services/certificate-status';
import { cn } from '@/lib/utils';

/**
 * Configuration wizard.
 *
 * The form is rendered from the field descriptors returned by `/api/protocols`,
 * so the configuration format is never hard-coded in the frontend. Advanced
 * fields are collapsed by default; protocol-specific fields appear dynamically
 * based on the current network/security selections.
 */

interface ServerRow {
  id: string;
  name: string;
  hostname: string;
  port: number;
  type: string;
  location: string | null;
  status: string;
}

/** The subset of a configuration the wizard needs to know which ports are taken. */
interface ExistingConfigRow {
  id: string;
  name: string;
  status: string;
  params: Record<string, unknown> | null;
  serverId: string;
}

interface UserRow {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
}

interface FieldDescriptor {
  name: string;
  label: string;
  type: 'text' | 'number' | 'password' | 'select' | 'switch' | 'textarea' | 'tags';
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { label: string; value: string }[];
  group: 'endpoint' | 'transport' | 'security' | 'advanced';
  visibleWhen?: { field: string; equals: string[] };
  advanced?: boolean;
}

interface ProtocolDescriptor {
  type: string;
  label: string;
  description: string;
  supportsMultiUser: boolean;
  fields: FieldDescriptor[];
}

interface CreateResult {
  config: { id: string; name: string; type: string };
  assignments: Array<{ id: string; userId: string; shareLink: string | null }>;
  artifact: {
    shareLink: string;
    filename: string;
    warnings: string[];
    protocol: string;
  } | null;
}

/** Units a configuration's allowance can be entered in. */
type TrafficUnit = 'GB' | 'MB';

/**
 * Quick-pick values per unit. Small allowances are far more natural in MB, so
 * the presets change with the unit rather than forcing everything into GB.
 */
const TRAFFIC_PRESETS: Record<TrafficUnit, string[]> = {
  GB: ['', '10', '50', '100', '500'],
  MB: ['', '100', '500', '1024', '5120'],
};
const EXPIRY_PRESETS = ['7', '30', '90', '365'];

const STEPS = ['Server', 'Protocol', 'Users', 'Limits', 'Advanced', 'Generate'] as const;

export default function NewConfigWizard() {
  const router = useRouter();
  const toast = useToast();

  const [step, setStep] = React.useState(0);
  const [serverId, setServerId] = React.useState('');
  const [protocol, setProtocol] = React.useState('');
  const [ownerId, setOwnerId] = React.useState('');
  /** Filters the "additional users" list — a long customer list is unusable without it. */
  const [userSearch, setUserSearch] = React.useState('');
  const [extraUserIds, setExtraUserIds] = React.useState<string[]>([]);
  const [name, setName] = React.useState('');
  const [trafficLimit, setTrafficLimit] = React.useState('');
  const [trafficLimitUnit, setTrafficLimitUnit] = React.useState<TrafficUnit>('GB');
  const [expirationDays, setExpirationDays] = React.useState('30');
  const [remarks, setRemarks] = React.useState('');
  const [params, setParams] = React.useState<Record<string, unknown>>({});
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [result, setResult] = React.useState<CreateResult | null>(null);

  const servers = useApi<{ data: ServerRow[] }>('/api/servers?pageSize=100');
  const users = useApi<{ data: UserRow[] }>('/api/users?pageSize=200');
  const protocols = useApi<{ protocols: ProtocolDescriptor[] }>('/api/protocols');
  // Which ports are already spoken for on this server. Without this the form
  // pre-filled the server's own port (443) and the second configuration was
  // always rejected — which reads as "choosing VLESS prevents me from creating"
  // even though the protocol is irrelevant.
  const existing = useApi<{ data: ExistingConfigRow[] }>('/api/configs?pageSize=200');

  /**
   * The node's TLS certificate.
   *
   * There is exactly ONE certificate for the whole server, and the panel adds it
   * to every TLS configuration automatically — the operator never enters it. The
   * only thing worth showing is whether it exists, because without it every TLS
   * configuration is skipped and nothing explains why.
   *
   * `useApi` already unwraps the `{ data }` envelope, so `data` IS the status
   * object — reaching for a further `.data` crashes the page.
   */
  const certificate = useApi<CertificateStatus>('/api/xray/certificate');

  const selectedServer = servers.data?.data.find((server) => server.id === serverId);
  const selectedProtocol = protocols.data?.protocols.find((item) => item.type === protocol);

  /** Ports held by ACTIVE configurations on the selected server. */
  const takenPorts = React.useMemo(() => {
    if (!selectedServer) return [] as number[];
    return claimedPorts(
      (existing.data?.data ?? [])
        .filter((config) => config.serverId === selectedServer.id && config.status === 'ACTIVE')
        .map((config) => ({ params: config.params, server: selectedServer })),
    );
  }, [existing.data, selectedServer]);

  /** A port the operator can actually use, preferring 443 when it is free. */
  const suggestedPort = React.useMemo(() => suggestPort(takenPorts), [takenPorts]);

  /**
   * A handful of ports that are free right now, offered as one-click shortcuts.
   *
   * The port field has always accepted any number; this just removes the guessing
   * (and the failed attempts on a port that is already serving another
   * configuration, which can never take a second one).
   */
  const portChoices = React.useMemo(() => {
    const taken = new Set(takenPorts);
    const usable = (port: number) => !taken.has(port) && !staticPortConflict(port);
    const out: number[] = [];
    for (const candidate of [443, 8443, 2053, 2083, 2087, 2096, 8080, 444]) {
      if (usable(candidate)) out.push(candidate);
    }
    for (let port = 2100; out.length < 8 && port < 2600; port += 1) {
      if (usable(port)) out.push(port);
    }
    return out.slice(0, 8);
  }, [takenPorts]);

  // Seed sensible defaults when the protocol or server changes.
  React.useEffect(() => {
    if (!selectedProtocol) return;
    const defaults: Record<string, unknown> = {};
    for (const field of selectedProtocol.fields) {
      if (field.type === 'switch') defaults[field.name] = false;
      if (field.type === 'select' && field.options?.length) defaults[field.name] = field.options[0]!.value;
    }
    defaults.address = selectedServer?.hostname ?? '';
    // Offer a FREE port, not the server's port. The server port is only a
    // default for the very first configuration; reusing it later collides.
    defaults.port = suggestedPort || selectedServer?.port || 443;
    defaults.network = 'tcp';
    // VLESS defaults to REALITY, not to "no security". Two hard facts force this:
    // the node certificate is self-signed (the sing-box family rejects it), and
    // Xray-26 clients refuse "VLESS without TLS over a bare IP" outright. REALITY
    // is the only VLESS form every app accepts with no client-side tweaks, and
    // the panel generates its keys automatically — so make it the default rather
    // than something the operator has to know to pick. Trojan keeps TLS (it has
    // no REALITY support here); Shadowsocks carries its own encryption.
    defaults.security =
      protocol === 'TROJAN' ? 'tls' : protocol === 'VLESS' ? 'reality' : 'none';
    if (protocol === 'VLESS') defaults.flow = 'xtls-rprx-vision';
    if (protocol === 'SHADOWSOCKS') defaults.method = 'chacha20-ietf-poly1305';
    setParams(defaults);
  }, [protocol, selectedProtocol, selectedServer, suggestedPort]);

  /** A field is visible when its dependency (if any) matches the current value. */
  function isVisible(field: FieldDescriptor): boolean {
    if (!field.visibleWhen) return true;
    const current = String(params[field.visibleWhen.field] ?? '');
    return field.visibleWhen.equals.includes(current);
  }

  const visibleFields = (selectedProtocol?.fields ?? []).filter(isVisible);
  const basicFields = visibleFields.filter((field) => !field.advanced);
  const advancedFields = visibleFields.filter((field) => field.advanced);

  function setParam(key: string, value: unknown) {
    setParams((current) => ({ ...current, [key]: value }));
  }

  /**
   * The port the operator has entered.
   *
   * Declared before the sharing checks because they all read it.
   */
  const chosenPort = Number(params.port);

  /**
   * Can this configuration share a port with the ones already on it?
   *
   * Sharing needs VLESS (or Trojan) with TLS on a path-capable transport. The
   * wizard says so plainly instead of letting the server refuse later.
   */
  const shareCheck = React.useMemo(() => {
    if (!protocol || !selectedServer) return null;
    if (!takenPorts.includes(chosenPort)) return null;

    return shareIneligible({
      id: 'pending',
      name: 'this configuration',
      protocol,
      security: String(params.security ?? ''),
      network: String(params.network ?? 'tcp'),
      path: params.path ? String(params.path) : null,
    });
  }, [protocol, selectedServer, takenPorts, chosenPort, params.security, params.network, params.path]);

  /** True when this configuration will join an existing port instead of taking one. */
  const sharing = shareCheck === null && takenPorts.includes(chosenPort);

  /**
   * What the transport settings must become for this configuration to be
   * servable on the port it was given.
   *
   * Purely computed so the rule lives in one tested place rather than being
   * re-derived in the UI.
   */
  const sharePreset = React.useMemo(
    () =>
      protocol
        ? shareDefaults({ protocol, portTaken: takenPorts.includes(chosenPort) })
        : { sharing: false, apply: {}, note: null },
    [protocol, takenPorts, chosenPort],
  );

  /**
   * Apply the sharing settings automatically.
   *
   * The operator should not have to know that sharing needs WebSocket + TLS —
   * choosing a port that is already in use with VLESS is enough. Previously this
   * was only *described*, so a configuration left on `tcp` could never join and
   * the panel looked like it was refusing the port.
   */
  React.useEffect(() => {
    if (!sharePreset.sharing) return;
    setParams((current) => {
      const next = { ...current };
      let changed = false;
      for (const [key, value] of Object.entries(sharePreset.apply)) {
        if (String(next[key] ?? '') !== value) {
          next[key] = value;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sharePreset]);

  /** A unique path for this configuration when it joins a shared port. */
  const suggestedPath = React.useMemo(
    () => `/vp-${Math.random().toString(36).slice(2, 10)}`,
    // A fresh suggestion each time the operator switches to sharing.
    [sharing],
  );

  // Seed the path automatically when the operator joins a shared port. Leaving
  // it out would make the configuration unreachable through the shared listener
  // — the traffic arrives, matches no fallback, and is dropped.
  React.useEffect(() => {
    if (!sharing) return;
    setParams((current) => {
      // A path is required, must start with "/", and must not be the certificate
      // fingerprint the operator may have pasted from elsewhere.
      const existing = current.path ? String(current.path) : '';
      const usable = existing.startsWith('/') && !/^[0-9a-f]{16,}$/i.test(existing.replace(/^\//, ''));
      return usable ? current : { ...current, path: suggestedPath };
    });
  }, [sharing, suggestedPath]);

  /**
   * Whether the chosen port can actually be used.
   *
   * Checked here so the wizard refuses to move on, rather than letting the
   * operator reach "Generate" and be rejected by the server. A port that is
   * already taken is fine when the configurations can SHARE it; it is only a
   * problem when they cannot.
   */
  const portProblem = React.useMemo(() => {
    if (!Number.isInteger(chosenPort) || chosenPort <= 0) return null;

    const reserved = staticPortConflict(chosenPort);
    if (reserved) return `Port ${chosenPort} is ${reserved.reason}. ${reserved.fix}.`;

    if (takenPorts.includes(chosenPort) && shareCheck !== null) {
      return `Port ${chosenPort} is already used by another configuration, and this one cannot share it — ${shareCheck.reason}. ${shareCheck.fix}`;
    }

    return null;
  }, [chosenPort, takenPorts, shareCheck]);

  /**
   * Whether the chosen path is usable.
   *
   * A path that does not start with "/" is normalised differently by clients, so
   * the listener and the client never agree on it and the configuration is
   * silently unreachable. A pasted certificate fingerprint is the other trap.
   * Both are caught here rather than producing a "port is open but nothing
   * connects" report later.
   */
  const pathProblem = React.useMemo(() => {
    const raw = params.path === undefined || params.path === null ? '' : String(params.path);
    if (raw === '') return null;
    if (!raw.startsWith('/')) return 'The path must start with "/".';
    if (/^\/?[0-9a-f]{16,}$/i.test(raw)) {
      return 'That looks like a certificate fingerprint, not a path. Use a short name such as /vp-main.';
    }
    return null;
  }, [params.path]);

  /**
   * The port the operator has entered, and whether it can be used.
   *
   * Checked here so the wizard refuses to move on, rather than letting the
   * operator reach "Generate" and be rejected by the server.
   */
  const canProceed = [
    Boolean(serverId),
    Boolean(protocol),
    Boolean(ownerId),
    true,
    // Block the parameters step while the chosen port cannot work, or the path
    // is one clients and the listener would disagree about.
    portProblem === null && pathProblem === null,
    Boolean(name.trim()),
  ];

  function next() {
    if (!canProceed[step]) {
      toast.warning('Incomplete step', 'Please complete the required selection before continuing.');
      return;
    }
    // Auto-suggest a name from server + protocol.
    if (step === 2 && !name.trim() && selectedServer && selectedProtocol) {
      setName(`${selectedServer.name} · ${selectedProtocol.label}`);
    }
    setStep((current) => Math.min(STEPS.length - 1, current + 1));
  }

  function back() {
    setStep((current) => Math.max(0, current - 1));
  }

  async function generate() {
    if (!serverId || !protocol || !ownerId) return;
    setSubmitting(true);
    try {
      // Never send an empty string for a field the operator left untouched: a
      // bare `""` fails enum validation ("Expected 'none' | 'tls' | 'reality'")
      // and the operator has no way to tell which control was empty. Dropping the
      // key lets the protocol's own default apply.
      const cleanParams: Record<string, unknown> = Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== '' && value !== undefined && value !== null),
      );

      // The security layer must always be explicit. Leaving it out is what
      // produced a link that claimed REALITY while carrying no keypair — and a
      // node that then skipped the configuration entirely.
      if (!cleanParams.security) {
        cleanParams.security = protocol === 'TROJAN' ? 'tls' : 'none';
      }

      const payload: Record<string, unknown> = {
        name: name.trim(),
        serverId,
        protocol,
        ownerId,
        userIds: extraUserIds.filter((id) => id !== ownerId),
        params: cleanParams,
        remarks: remarks || undefined,
        // The allowance belongs to the configuration. Send whichever unit the
        // operator chose; the service converts it.
        ...(trafficLimit === ''
          ? {}
          : trafficLimitUnit === 'MB'
            ? { trafficLimitMb: Number(trafficLimit) }
            : { trafficLimitGb: Number(trafficLimit) }),
        expirationDays: expirationDays ? Number(expirationDays) : null,
      };

      const created = await api.post<CreateResult>('/api/configs', payload);
      setResult(created);
      toast.success('Configuration generated', 'Copy the link, show the QR code or download the file.');
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : 'Could not generate the configuration.';
      const details = caught instanceof ApiError && caught.details ? caught.details : null;
      toast.error(
        'Generation failed',
        details ? `${message} — ${JSON.stringify(details).slice(0, 180)}` : message,
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------- result view
  if (result) {
    const artifact = result.artifact;
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader
          title="Configuration generated"
          description="Deliver the link below to the assigned user. Their credential is unique to them."
        />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-success" /> {result.config.name}
            </CardTitle>
            <CardDescription>
              {result.config.type} · {result.assignments.length} user(s) assigned
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {artifact?.warnings.length ? (
              <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm">
                <p className="font-medium">Advisories</p>
                <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                  {artifact.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Import link
                </p>
                <div className="max-h-28 overflow-y-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] break-all">
                  {artifact?.shareLink ?? 'Available per user on the configuration page.'}
                </div>
              </div>

              <div className="flex items-center justify-center rounded-lg border border-border bg-white p-3">
                <img
                  src={`/api/configs/${result.config.id}/qr?format=png`}
                  alt="Configuration QR code"
                  width={224}
                  height={224}
                  className="size-56"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={async () => {
                  if (!artifact?.shareLink) return;
                  const ok = await copyToClipboard(artifact.shareLink);
                  ok ? toast.success('Copied') : toast.error('Clipboard unavailable');
                }}
              >
                <Copy /> Copy configuration
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void downloadFile(
                    `/api/configs/${result.config.id}/download?format=json`,
                    `${result.config.type.toLowerCase()}-config.json`,
                  )
                }
              >
                <Download /> Download config
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void downloadFile(
                    `/api/configs/${result.config.id}/download?format=qr`,
                    `${result.config.type.toLowerCase()}-qr.png`,
                  )
                }
              >
                <QrCode /> Download QR
              </Button>
              <Button variant="ghost" asChild>
                <Link href={`/configs/${result.config.id}`}>View configuration</Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-between">
          <Button
            variant="outline"
            onClick={() => {
              setResult(null);
              setStep(0);
            }}
          >
            <ArrowLeft /> Create another
          </Button>
          <Button asChild>
            <Link href="/configs">
              Go to configurations <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- wizard view
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Create configuration"
        description="Generate a ready-to-import configuration for one or more users."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/configs">
              <ArrowLeft /> Back to configurations
            </Link>
          </Button>
        }
      />

      {/* Step indicator */}
      <ol className="flex flex-wrap items-center gap-2">
        {STEPS.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => index < step && setStep(index)}
              disabled={index > step}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                index === step
                  ? 'border-primary bg-primary/10 text-primary'
                  : index < step
                    ? 'border-success/40 bg-success/10 text-success'
                    : 'border-border text-muted-foreground',
              )}
            >
              <span className="flex size-4 items-center justify-center rounded-full bg-current/20 text-[10px]">
                {index < step ? <Check className="size-3" /> : index + 1}
              </span>
              {label}
            </button>
            {index < STEPS.length - 1 ? <span className="text-muted-foreground">›</span> : null}
          </li>
        ))}
      </ol>

      <Card>
        <CardHeader>
          <CardTitle>
            {step === 0 && '1. Select a server'}
            {step === 1 && '2. Select a protocol'}
            {step === 2 && '3. Assign to user(s)'}
            {step === 3 && '4. Traffic limit and expiration'}
            {step === 4 && '5. Advanced settings'}
            {step === 5 && '6. Review and generate'}
          </CardTitle>
          <CardDescription>
            {step === 0 && 'Only servers you have registered can be selected.'}
            {step === 1 && 'The form below adapts to the protocol you choose.'}
            {step === 2 && 'Each selected user receives an independent credential.'}
            {step === 3 && 'Applied to every assigned user. Leave blank to keep their current values.'}
            {step === 4 && 'Transport and security parameters. Defaults work for most setups.'}
            {step === 5 && 'Confirm the details, then generate.'}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {/* Step 1 — server */}
          {step === 0 ? (
            servers.loading ? (
              <Skeleton className="h-32" />
            ) : (servers.data?.data.length ?? 0) === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-8 text-center">
                <ServerIcon className="mx-auto size-6 text-muted-foreground" />
                <p className="mt-2 text-sm font-medium">No servers registered</p>
                <p className="text-sm text-muted-foreground">
                  Add a server before creating configurations.
                </p>
                <Button className="mt-4" size="sm" asChild>
                  <Link href="/servers/new">Add server</Link>
                </Button>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {servers.data?.data.map((server) => (
                  <button
                    key={server.id}
                    type="button"
                    onClick={() => setServerId(server.id)}
                    className={cn(
                      'flex items-start justify-between gap-3 rounded-lg border p-3 text-left transition-colors',
                      serverId === server.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-muted/50',
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{server.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {server.hostname}:{server.port}
                        {server.location ? ` · ${server.location}` : ''}
                      </p>
                    </div>
                    <StatusBadge status={server.status} />
                  </button>
                ))}
              </div>
            )
          ) : null}

          {/* Step 2 — protocol */}
          {step === 1 ? (
            protocols.loading ? (
              <Skeleton className="h-32" />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {protocols.data?.protocols.map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    onClick={() => setProtocol(item.type)}
                    className={cn(
                      'rounded-lg border p-3 text-left transition-colors',
                      protocol === item.type
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-muted/50',
                    )}
                  >
                    <p className="font-medium">{item.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
                    {item.supportsMultiUser ? (
                      <span className="mt-1.5 inline-block text-[11px] text-success">
                        Supports independent per-user credentials
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )
          ) : null}

          {/* Step 3 — users */}
          {step === 2 ? (
            users.loading ? (
              <Skeleton className="h-32" />
            ) : (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Primary user (owner)</Label>
                  <Select value={ownerId} onValueChange={setOwnerId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select the user this configuration belongs to" />
                    </SelectTrigger>
                    <SelectContent>
                      {users.data?.data.map((user) => (
                        <SelectItem key={user.id} value={user.id}>
                          {user.displayName ?? user.username} · {user.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    The primary user keeps any credential you enter below.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <UsersIcon className="size-3.5" /> Additional users (optional)
                  </Label>
                  <Input
                    value={userSearch}
                    onChange={(event) => setUserSearch(event.target.value)}
                    placeholder="Search users by name, username or email…"
                    aria-label="Search users"
                  />
                  <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                    {(users.data?.data ?? [])
                      .filter((user) => user.id !== ownerId)
                      .filter((user) => {
                        const q = userSearch.trim().toLowerCase();
                        if (!q) return true;
                        return [user.username, user.displayName ?? '', user.email]
                          .some((value) => value.toLowerCase().includes(q));
                      })
                      .map((user) => (
                        <label
                          key={user.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                        >
                          <Checkbox
                            checked={extraUserIds.includes(user.id)}
                            onCheckedChange={(checked) =>
                              setExtraUserIds((current) =>
                                checked
                                  ? [...current, user.id]
                                  : current.filter((id) => id !== user.id),
                              )
                            }
                          />
                          <span className="truncate">
                            {user.displayName ?? user.username}
                            <span className="ml-1 text-xs text-muted-foreground">{user.email}</span>
                          </span>
                        </label>
                      ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Every additional user gets their own freshly generated credential — they can
                    never see each other&apos;s.
                  </p>
                </div>
              </div>
            )
          ) : null}

          {/* Step 4 — limits */}
          {step === 3 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="name">
                  Configuration name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Germany Node 01"
                />
              </div>

              <div className="space-y-1.5">
                  <Label htmlFor="limit">Traffic limit for this configuration</Label>
                  <div className="flex gap-2">
                    <Input
                      id="limit"
                      type="number"
                      min={0}
                      value={trafficLimit}
                      onChange={(event) => setTrafficLimit(event.target.value)}
                      placeholder="Blank = unlimited"
                    />
                    <Select
                      value={trafficLimitUnit}
                      onValueChange={(value) => setTrafficLimitUnit(value as TrafficUnit)}
                    >
                      <SelectTrigger className="w-[84px]" aria-label="Traffic limit unit">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="GB">GB</SelectItem>
                        <SelectItem value="MB">MB</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {TRAFFIC_PRESETS[trafficLimitUnit].map((preset) => (
                      <button
                        key={preset || 'unlimited'}
                        type="button"
                        onClick={() => setTrafficLimit(preset)}
                        className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {preset === '' ? 'Unlimited' : `${preset} ${trafficLimitUnit}`}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    When this configuration reaches its limit it is stopped automatically and its
                    clients can no longer connect. Raise the limit or reset the counter to resume.
                  </p>
                </div>

              <div className="space-y-1.5">
                <Label htmlFor="expiry">Expires in (days)</Label>
                <Input
                  id="expiry"
                  type="number"
                  min={1}
                  value={expirationDays}
                  onChange={(event) => setExpirationDays(event.target.value)}
                />
                <div className="flex flex-wrap gap-1">
                  {EXPIRY_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setExpirationDays(preset)}
                      className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {preset} days
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="remarks">Remarks</Label>
                <Textarea
                  id="remarks"
                  value={remarks}
                  onChange={(event) => setRemarks(event.target.value)}
                  placeholder="Optional note shown alongside this configuration."
                  className="min-h-[38px]"
                />
              </div>
            </div>
          ) : null}

          {/* Step 5 — protocol parameters */}
          {step === 4 && selectedProtocol ? (
            <div className="space-y-5">
              {/* Say which ports are taken, up front. A rejected configuration
                  with no explanation is what made this look like a protocol
                  problem rather than a port collision. */}
              {portProblem || pathProblem ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                  <p className="text-sm font-medium text-destructive">
                    {portProblem ? 'Port unavailable' : 'Path not usable'}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {portProblem ?? pathProblem}
                  </p>
                </div>
              ) : sharing ? (
                <div className="rounded-md border border-info/40 bg-info/5 px-3 py-2">
                  <p className="text-sm font-medium">
                    Port {chosenPort} is shared — everything is set up for you.
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {takenPorts.length} configuration{takenPorts.length === 1 ? '' : 's'} already use
                    port {chosenPort}. Xray routes each one by its path, so they all stay separate —
                    each keeps its own credential, traffic counter and limit. Transport and security
                    were switched to <span className="font-mono text-foreground">ws</span> +{' '}
                    <span className="font-mono text-foreground">tls</span> automatically, and this one
                    gets the path <span className="font-mono text-foreground">{suggestedPath}</span>.
                    You can change it, but it must start with &quot;/&quot;.
                  </p>
                </div>
              ) : takenPorts.length > 0 ? (
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                  <p className="text-sm font-medium">
                    Port {suggestedPort} is free and has been selected for you.
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Already in use on this server: {takenPorts.join(', ')}. To put this one on{' '}
                    {takenPorts[0]} instead, just type {takenPorts[0]} as the port — it will be set to
                    share automatically.
                  </p>
                </div>
              ) : null}

              {/* The certificate is added for you — there is one for the whole
                  server and it never goes into a configuration. Shown only so a
                  missing one is visible before it silently skips every TLS
                  configuration. */}
              {String(params.security) === 'tls' && certificate.data ? (
                certificate.data.tlsConfigsWillServe ? (
                  <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                    <div>
                      <p className="text-sm font-medium">TLS certificate ready — no action needed</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        One certificate covers every TLS configuration on this server. It is added
                        automatically when the node config is built, so there is nothing to paste
                        here. Fingerprint{' '}
                        <span className="font-mono text-foreground">
                          {certificate.data.pinShort}
                        </span>
                        . If you replace the certificate, every client link you have already shared
                        must be re-issued.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                    <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <div>
                      <p className="text-sm font-medium text-destructive">
                        No TLS certificate — this configuration will not connect
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Every TLS configuration needs the certificate at{' '}
                        <span className="font-mono">{certificate.data.certPath}</span>, and it is
                        missing. {certificate.data.fix} Then reload this page.
                      </p>
                    </div>
                  </div>
                )
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                {basicFields.map((field) => (
                  <FieldControl
                    key={field.name}
                    field={field}
                    value={params[field.name]}
                    onChange={(value) => setParam(field.name, value)}
                    sharedPortTransportWarning={takenPorts.includes(chosenPort)}
                    portChoices={portChoices}
                  />
                ))}
              </div>

              <div className="rounded-md border border-border">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((current) => !current)}
                  className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
                >
                  Advanced settings
                  <ChevronDown
                    className={cn('size-4 transition-transform', showAdvanced && 'rotate-180')}
                  />
                </button>
                {showAdvanced ? (
                  <div className="grid gap-4 border-t border-border p-3 sm:grid-cols-2">
                    {advancedFields.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No advanced options for this protocol.
                      </p>
                    ) : (
                      advancedFields.map((field) => (
                        <FieldControl
                          key={field.name}
                          field={field}
                          value={params[field.name]}
                          onChange={(value) => setParam(field.name, value)}
                          sharedPortTransportWarning={takenPorts.includes(chosenPort)}
                    portChoices={portChoices}
                        />
                      ))
                    )}
                  </div>
                ) : null}
              </div>

              <p className="text-xs text-muted-foreground">
                A credential is generated automatically for each user if you leave the credential
                field blank.
              </p>
            </div>
          ) : null}

          {/* Step 6 — review */}
          {step === 5 ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <ReviewRow label="Server" value={selectedServer ? `${selectedServer.name} (${selectedServer.hostname}:${selectedServer.port})` : '—'} />
                <ReviewRow label="Protocol" value={protocol || '—'} />
                <ReviewRow
                  label="Primary user"
                  value={
                    users.data?.data.find((user) => user.id === ownerId)?.username ?? '—'
                  }
                />
                <ReviewRow
                  label="Additional users"
                  value={extraUserIds.length ? `${extraUserIds.length} user(s)` : 'None'}
                />
                <ReviewRow label="Name" value={name || '—'} />
                <ReviewRow
                  label="Traffic limit"
                  value={trafficLimit === '' ? 'Unlimited' : `${trafficLimit} ${trafficLimitUnit}`}
                />
                <ReviewRow label="Expires in" value={expirationDays ? `${expirationDays} days` : 'No expiry'} />
                <ReviewRow
                  label="Transport"
                  value={`${String(params.network ?? 'tcp')} / ${String(params.security ?? 'none')}`}
                />
                {sharing ? (
                  <ReviewRow
                    label="Shared port"
                    value={`port ${chosenPort} · path ${String(params.path ?? '—')}`}
                  />
                ) : null}
              </div>

              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Parameters
                </p>
                <pre className="mt-1 max-h-48 overflow-auto text-[11px] leading-relaxed">
                  {JSON.stringify(params, null, 2)}
                </pre>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={back} disabled={step === 0}>
          <ArrowLeft /> Back
        </Button>

        {step < STEPS.length - 1 ? (
          <Button onClick={next} disabled={!canProceed[step]}>
            Continue <ArrowRight />
          </Button>
        ) : (
          <Button onClick={() => void generate()} loading={submitting}>
            <Wand2 /> Generate configuration
          </Button>
        )}
      </div>
    </div>
  );
}

/** Renders a single dynamic field based on its descriptor. */
function FieldControl({
  field,
  value,
  onChange,
  sharedPortTransportWarning = false,
  portChoices,
}: {
  field: FieldDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
  /** True when the chosen port is already in use, so only a path transport works. */
  sharedPortTransportWarning?: boolean;
  /** Free ports offered as one-click shortcuts under the port field. */
  portChoices?: number[];
}) {
  const help = field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null;

  if (field.type === 'switch') {
    return (
      <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
        <div>
          <p className="text-sm font-medium">{field.label}</p>
          {help}
        </div>
        <Switch checked={Boolean(value)} onCheckedChange={onChange} />
      </div>
    );
  }

  // The Path field has two traps the operator has actually fallen into:
  // pasting the certificate fingerprint (a long hex string), and leaving off the
  // leading "/". Both produce a configuration that looks fine and is silently
  // unreachable, so they are called out right at the input.
  if (field.name === 'path') {
    const raw = String(value ?? '');
    const fingerprint = /^\/?[0-9a-f]{16,}$/i.test(raw);
    const needsSlash = raw !== '' && !raw.startsWith('/');
    const problem = fingerprint
      ? 'That looks like a certificate fingerprint. A path is a short name such as /vp-main — the certificate is added for you already.'
      : needsSlash
        ? 'A path must start with "/".'
        : null;

    return (
      <div className="space-y-1.5">
        <Label>{field.label}</Label>
        <Input
          value={raw}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder ?? '/vp-main'}
          className={problem ? 'border-destructive/60' : undefined}
        />
        {problem ? (
          <p className="text-xs text-destructive">{problem}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            A short name that must start with &quot;/&quot;. Each configuration sharing a port needs
            a different one.
          </p>
        )}
      </div>
    );
  }

  // The transport, when the chosen port is shared.
  //
  // Only `ws` (or httpupgrade/xhttp/grpc) can be routed by the shared listener —
  // it matches the request *path*. `tcp` carries no path, so a `tcp` client
  // reaches the port, completes the TLS handshake, and then matches no fallback:
  // the node drops it into the default destination. On the phone this is
  // indistinguishable from a working server, because the port is open and the
  // ping succeeds — only the data never flows.
  if (field.name === 'network' && sharedPortTransportWarning) {
    const isTcp = String(value ?? '') === 'tcp';
    return (
      <div className="space-y-1.5">
        <Label>{field.label}</Label>
        <Select value={String(value ?? '')} onValueChange={onChange}>
          <SelectTrigger className={isTcp ? 'border-destructive/60' : undefined}>
            <SelectValue placeholder={field.placeholder ?? 'Select…'} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isTcp ? (
          <p className="text-xs text-destructive">
            A shared port needs a transport that carries a path — use <strong>ws</strong>. With
            <strong> tcp</strong> this port stays open and answers pings, but no data ever passes.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{help}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label>
        {field.label}
        {field.required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>

      {field.type === 'select' ? (
        // Radix Select cannot use an empty string as an item value, so the
        // sentinel "none" round-trips to "" (which is a valid value for fields
        // such as VLESS `flow`).
        <Select
          value={value === '' || value === undefined || value === null ? 'none' : String(value)}
          onValueChange={(next) => onChange(next === 'none' ? '' : next)}
        >
          <SelectTrigger>
            <SelectValue placeholder={field.placeholder ?? 'Select…'} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem
                key={option.value === '' ? '__none__' : option.value}
                value={option.value === '' ? 'none' : option.value}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === 'tags' ? (
        <Input
          value={Array.isArray(value) ? (value as string[]).join(', ') : String(value ?? '')}
          onChange={(event) =>
            onChange(
              event.target.value
                .split(',')
                .map((part) => part.trim())
                .filter(Boolean),
            )
          }
          placeholder={field.placeholder}
        />
      ) : field.type === 'textarea' ? (
        <Textarea
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
        />
      ) : (
        <>
          <Input
            type={field.type === 'number' ? 'number' : field.type === 'password' ? 'text' : 'text'}
            value={String(value ?? '')}
            onChange={(event) =>
              onChange(field.type === 'number' ? Number(event.target.value) : event.target.value)
            }
            placeholder={field.placeholder}
          />
          {field.name === 'port' ? (
            <>
              {portChoices && portChoices.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 pt-1">
                  <span className="text-xs text-muted-foreground">Free right now:</span>
                  {portChoices.map((port) => (
                    <button
                      key={port}
                      type="button"
                      onClick={() => onChange(port)}
                      className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {port}
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Type <strong>any</strong> port from 1024 to 65535 — the buttons are only a
                shortcut. A port already used by another configuration cannot take a second
                configuration: to put another customer on it, open that configuration and use{' '}
                <strong>Add user</strong>.
              </p>
            </>
          ) : null}
        </>
      )}

      {help}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-medium">{value}</p>
    </div>
  );
}

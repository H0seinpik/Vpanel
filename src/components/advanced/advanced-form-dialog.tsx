'use client';

import * as React from 'react';
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

/**
 * Descriptor-driven form dialog for the advanced Xray objects.
 *
 * The four sections (Inbounds / Outbounds / Routing / Reverse proxy) differ only
 * in their fields, so one dialog renders all of them from a `FieldSpec[]`. That
 * keeps the 3x-ui behaviour (JSON editors for the raw Xray sections) without
 * bringing over any of 3x-ui's CSS — everything here is VPanel's own primitives.
 */

export type FieldType = 'text' | 'number' | 'json' | 'lines' | 'select' | 'switch';

export interface FieldSpec {
  name: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  help?: string;
  options?: Array<{ label: string; value: string }>;
  required?: boolean;
  /** 2 spans the full width of the two-column grid. */
  span?: 1 | 2;
  rows?: number;
}

type FieldValue = string | boolean;
type FieldValues = Record<string, FieldValue>;

function toFieldValue(field: FieldSpec, raw: unknown): FieldValue {
  if (field.type === 'switch') return raw === undefined ? true : Boolean(raw);
  if (raw === undefined || raw === null) return '';
  if (field.type === 'json') return JSON.stringify(raw, null, 2);
  if (field.type === 'lines') return Array.isArray(raw) ? raw.join('\n') : String(raw);
  return String(raw);
}

function toPayloadValue(field: FieldSpec, value: FieldValue): unknown {
  if (field.type === 'switch') return Boolean(value);

  const text = String(value ?? '').trim();

  if (field.type === 'json') {
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${field.label} is not valid JSON`);
    }
  }
  if (field.type === 'lines') {
    return text ? text.split('\n').map((line) => line.trim()).filter(Boolean) : [];
  }
  if (field.type === 'number') {
    if (!text) return undefined;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) throw new Error(`${field.label} must be a number`);
    return parsed;
  }
  return text || undefined;
}

export function AdvancedFormDialog({
  open,
  onOpenChange,
  title,
  description,
  fields,
  initial,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  fields: FieldSpec[];
  /** The row being edited. Read field-by-field, so any object shape is fine. */
  initial?: object | null;
  submitLabel?: string;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [values, setValues] = React.useState<FieldValues>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Reset ONLY when the dialog opens. Depending on `initial` would wipe the form
  // every time the list refreshes in the background.
  React.useEffect(() => {
    if (!open) return;
    const source = (initial ?? {}) as Record<string, unknown>;
    const next: FieldValues = {};
    for (const field of fields) next[field.name] = toFieldValue(field, source[field.name]);
    setValues(next);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function set(name: string, value: FieldValue) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    for (const field of fields) {
      if (!field.required || field.type === 'switch') continue;
      if (!String(values[field.name] ?? '').trim()) {
        setError(`${field.label} is required`);
        return;
      }
    }

    let payload: Record<string, unknown>;
    try {
      payload = {};
      for (const field of fields) {
        const raw = toPayloadValue(
          field,
          values[field.name] ?? (field.type === 'switch' ? false : ''),
        );
        // Switches are always sent (false is meaningful); empty text/number/JSON
        // is omitted so a PATCH leaves the stored value untouched.
        if (raw !== undefined) payload[field.name] = raw;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Invalid input');
      return;
    }

    setBusy(true);
    try {
      await onSubmit(payload);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <div
                key={field.name}
                className={field.span === 2 ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'}
              >
                <Label htmlFor={`adv-${field.name}`}>{field.label}</Label>

                {field.type === 'select' ? (
                  <Select
                    value={String(values[field.name] ?? '')}
                    onValueChange={(value) => set(field.name, value)}
                  >
                    <SelectTrigger id={`adv-${field.name}`}>
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
                ) : field.type === 'switch' ? (
                  <div className="flex h-9 items-center">
                    <Switch
                      id={`adv-${field.name}`}
                      checked={Boolean(values[field.name])}
                      onCheckedChange={(checked) => set(field.name, checked)}
                    />
                  </div>
                ) : field.type === 'json' || field.type === 'lines' ? (
                  <Textarea
                    id={`adv-${field.name}`}
                    value={String(values[field.name] ?? '')}
                    onChange={(event) => set(field.name, event.target.value)}
                    placeholder={field.placeholder}
                    rows={field.rows ?? 4}
                    className="font-mono text-xs"
                  />
                ) : (
                  <Input
                    id={`adv-${field.name}`}
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={String(values[field.name] ?? '')}
                    onChange={(event) => set(field.name, event.target.value)}
                    placeholder={field.placeholder}
                  />
                )}

                {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
              </div>
            ))}
          </div>

          {error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {submitLabel ?? 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

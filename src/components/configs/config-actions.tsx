'use client';

import * as React from 'react';
import { Check, Copy, Download, QrCode, Share2, Smartphone } from 'lucide-react';
import { copyToClipboard, downloadFile } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Hint } from '@/components/ui/avatar';
import { useToast } from '@/components/ui/toast';

/**
 * Configuration delivery actions.
 *
 * Every action hits an authenticated endpoint that re-checks ownership, so the
 * same component is safe to reuse for staff and for end users:
 *   - Copy        → the import URL
 *   - Show QR     → PNG rendered server-side from the same payload
 *   - Download    → the full client config file
 *   - Open in app → copies the link and explains the clipboard import flow
 *                   (no protocol handler is registered by these clients, so a
 *                   deep link is not reliably supported)
 */
export function ConfigActions({
  configId,
  name,
  protocol,
  shareLink,
  /** Staff must name the target user; users omit it (defaults to themselves). */
  userId,
  size = 'sm',
  compact = false,
}: {
  configId: string;
  name: string;
  protocol: string;
  shareLink?: string | null;
  userId?: string;
  size?: 'sm' | 'default' | 'icon-sm';
  compact?: boolean;
}) {
  const toast = useToast();
  const [qrOpen, setQrOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [link, setLink] = React.useState(shareLink ?? '');

  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const qrUrl = `/api/configs/${configId}/qr${userId ? `${query}&format=png` : '?format=png'}`;
  const downloadUrl = `/api/configs/${configId}/download${userId ? `${query}&format=json` : '?format=json'}`;

  /** Fetch the link lazily when it was not supplied (e.g. admin tables). */
  async function ensureLink(): Promise<string> {
    if (link) return link;
    const response = await fetch(`/api/configs/${configId}/qr${userId ? `${query}&format=json` : '?format=json'}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Could not retrieve the configuration link.');
    const payload = (await response.json()) as { data?: { shareLink?: string } };
    const resolved = payload.data?.shareLink ?? '';
    setLink(resolved);
    return resolved;
  }

  async function handleCopy() {
    try {
      const value = await ensureLink();
      if (!value) throw new Error('No link available');
      const ok = await copyToClipboard(value);
      if (!ok) throw new Error('Clipboard unavailable');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Configuration copied', 'Paste it into your client to import.');
    } catch (error) {
      toast.error('Copy failed', error instanceof Error ? error.message : undefined);
    }
  }

  async function handleDownload() {
    try {
      await downloadFile(downloadUrl, `${protocol.toLowerCase()}-config.json`);
      toast.success('Download started');
    } catch {
      toast.error('Download failed');
    }
  }

  async function handleOpenInClient() {
    try {
      const value = await ensureLink();
      const ok = await copyToClipboard(value);
      toast.success(
        'Import link copied',
        ok
          ? 'Open your client (e.g. NekoBox), choose “Import from clipboard”, then paste.'
          : 'Copy the link manually from the QR dialog.',
      );
    } catch {
      toast.error('Could not prepare the import link');
    }
  }

  if (compact) {
    return (
      <div className="flex items-center gap-1">
        <Hint label="Copy configuration">
          <Button variant="ghost" size="icon-sm" onClick={() => void handleCopy()} aria-label="Copy configuration">
            {copied ? <Check className="text-success" /> : <Copy />}
          </Button>
        </Hint>
        <Hint label="Show QR code">
          <Button variant="ghost" size="icon-sm" onClick={() => setQrOpen(true)} aria-label="Show QR code">
            <QrCode />
          </Button>
        </Hint>
        <Hint label="Download configuration">
          <Button variant="ghost" size="icon-sm" onClick={() => void handleDownload()} aria-label="Download configuration">
            <Download />
          </Button>
        </Hint>

        <QrDialog open={qrOpen} onOpenChange={setQrOpen} name={name} protocol={protocol} qrUrl={qrUrl} link={link} onCopy={handleCopy} />
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="default" size={size} onClick={() => void handleCopy()}>
        {copied ? <Check /> : <Copy />} Copy configuration
      </Button>
      <Button variant="outline" size={size} onClick={() => setQrOpen(true)}>
        <QrCode /> Show QR code
      </Button>
      <Button variant="outline" size={size} onClick={() => void handleDownload()}>
        <Download /> Download
      </Button>
      <Button variant="outline" size={size} onClick={() => void handleOpenInClient()}>
        <Smartphone /> Open in client
      </Button>

      <QrDialog open={qrOpen} onOpenChange={setQrOpen} name={name} protocol={protocol} qrUrl={qrUrl} link={link} onCopy={handleCopy} />
    </div>
  );
}

function QrDialog({
  open,
  onOpenChange,
  name,
  protocol,
  qrUrl,
  link,
  onCopy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  protocol: string;
  qrUrl: string;
  link: string;
  onCopy: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>
            Scan this code with NekoBox, v2rayN, Shadowrocket or sing-box — or copy the import link.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          <div className="rounded-lg border border-border bg-white p-3">
            {/* Rendered server-side so the credential never reaches JS as data. */}
            <img
              src={qrUrl}
              alt={`QR code for ${name}`}
              width={288}
              height={288}
              className="size-72"
            />
          </div>

          <div className="w-full space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {protocol} import link
            </p>
            <div className="max-h-24 overflow-y-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed break-all">
              {link || 'Generating…'}
            </div>
          </div>

          <div className="flex w-full gap-2">
            <Button variant="outline" className="flex-1" onClick={() => void onCopy()}>
              <Copy /> Copy link
            </Button>
            <Button variant="outline" className="flex-1" asChild>
              <a href={qrUrl} download={`${name}-qr.png`}>
                <Share2 /> Download QR
              </a>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

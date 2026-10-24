import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/session';
import { getPublicSettings } from '@/server/services/settings-service';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Login page.
 *
 * Rendered on the server so an already-authenticated visitor is redirected
 * straight to their dashboard, and so the branding/app name comes from settings
 * without an extra client round-trip.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  let appName = 'VPanel';
  let footerText = '';
  try {
    const settings = await getPublicSettings();
    appName = settings.appName;
    footerText = settings.branding.footerText;
  } catch {
    // Fall back to defaults if the database is unavailable.
  }

  return (
    <div className="flex min-h-screen">
      {/* Left: brand panel (hidden on small screens) */}
      <div className="relative hidden w-1/2 flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-md bg-sidebar-active">
            <ShieldCheck className="size-5 text-white" />
          </div>
          <span className="text-base font-semibold">{appName}</span>
        </div>

        <div className="space-y-4">
          <h1 className="max-w-md text-2xl font-semibold leading-snug">
            Manage your authorized proxy infrastructure from one place.
          </h1>
          <ul className="space-y-2 text-sm text-sidebar-muted">
            <li>Server health, CPU, RAM and bandwidth monitoring</li>
            <li>VLESS / VMess / Trojan / Shadowsocks configuration generation</li>
            <li>Per-user traffic quotas, expiry dates and audit logging</li>
            <li>QR codes and import links for NekoBox, v2rayN and sing-box</li>
          </ul>
        </div>

        <p className="text-xs text-sidebar-muted">
          Only servers registered by an administrator are ever managed by this panel.
        </p>
      </div>

      {/* Right: form */}
      <div className="flex w-full items-center justify-center px-4 py-10 lg:w-1/2">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <div className="flex size-9 items-center justify-center rounded-md bg-primary">
              <ShieldCheck className="size-5 text-primary-foreground" />
            </div>
            <span className="text-base font-semibold">{appName}</span>
          </div>

          <LoginForm defaultNext={searchParams.next ?? '/dashboard'} />

          {footerText ? (
            <p className="mt-8 text-center text-xs text-muted-foreground">{footerText}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

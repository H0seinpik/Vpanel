import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ToastProvider } from '@/components/ui/toast';
import { themeInitScript } from '@/components/layout/theme';
import { getPublicSettings } from '@/server/services/settings-service';

/**
 * Root layout.
 *
 * The theme is applied by a blocking inline script so there is no flash of the
 * wrong colour scheme. `metadata` is generated from the configured app name so
 * branding settings take effect in the browser tab.
 */

export async function generateMetadata(): Promise<Metadata> {
  let appName = 'VPanel';
  try {
    const settings = await getPublicSettings();
    appName = settings.appName;
  } catch {
    // Database not reachable during build — fall back to the default name.
  }

  return {
    title: {
      default: `${appName} — Proxy Management`,
      template: `%s · ${appName}`,
    },
    description:
      'Administrative panel for managing authorized V2Ray/Xray configurations, users, traffic and infrastructure.',
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1220' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the stored theme before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-background">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}

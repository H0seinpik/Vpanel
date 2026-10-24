import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { capabilitiesFor } from '@/lib/auth/rbac';
import { getPublicSettings } from '@/server/services/settings-service';
import { AppShell } from '@/components/layout/app-shell';

/**
 * Authenticated layout.
 *
 * This is the real authentication gate: the session is resolved on the server
 * from the httpOnly cookie, and an unauthenticated visitor is redirected before
 * any protected markup is produced. Every page inside additionally re-checks
 * authorisation for its own data.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const settings = await getPublicSettings();

  return (
    <AppShell
      user={{
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        status: user.status,
      }}
      capabilities={capabilitiesFor(user.role)}
      appName={settings.appName}
    >
      {children}
    </AppShell>
  );
}

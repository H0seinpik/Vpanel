'use client';

import * as React from 'react';
import type { Capability } from '@/lib/auth/rbac';
import { Sidebar } from './sidebar';
import { Topbar, type SessionSummary } from './topbar';
import { ADMIN_NAV, USER_NAV } from './nav-config';

/**
 * Application shell: sidebar + topbar + content area.
 *
 * The server layout resolves the session and passes it in; this component only
 * handles presentation state (drawer open, rail collapsed). Navigation is built
 * from the caller's capability list.
 */
export function AppShell({
  user,
  capabilities,
  appName,
  children,
}: {
  user: SessionSummary;
  capabilities: Capability[];
  appName: string;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);

  const sections = user.role === 'USER' ? USER_NAV : ADMIN_NAV;

  // Persist the rail preference across reloads.
  React.useEffect(() => {
    setCollapsed(localStorage.getItem('vpanel-sidebar-collapsed') === 'true');
  }, []);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem('vpanel-sidebar-collapsed', String(next));
      return next;
    });
  }, []);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar
        sections={sections}
        capabilities={capabilities}
        appName={appName}
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={user}
          capabilities={capabilities}
          sections={sections}
          onOpenMobileNav={() => setMobileOpen(true)}
        />
        <main className="min-w-0 flex-1 px-4 py-6 lg:px-6">{children}</main>
        <footer className="border-t border-border px-6 py-3 text-xs text-muted-foreground">
          {appName} — administrative panel for authorized infrastructure.
        </footer>
      </div>
    </div>
  );
}

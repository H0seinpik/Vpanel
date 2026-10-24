'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bell,
  Check,
  LogOut,
  Menu,
  Search,
  User as UserIcon,
} from 'lucide-react';
import type { Capability } from '@/lib/auth/rbac';
import { api } from '@/lib/api-client';
import { useApi } from '@/hooks/use-api';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, initialsOf } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusBadge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { ThemeToggle } from './theme';
import { visibleSections, type NavSection } from './nav-config';

interface NotificationRow {
  id: string;
  title: string;
  message: string;
  severity: string;
  isRead: boolean;
  createdAt: string;
}

export interface SessionSummary {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  role: string;
  status: string;
}

export function Topbar({
  user,
  capabilities,
  sections,
  onOpenMobileNav,
}: {
  user: SessionSummary;
  capabilities: Capability[];
  sections: NavSection[];
  onOpenMobileNav: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = React.useState('');
  const [searchOpen, setSearchOpen] = React.useState(false);

  const { data: notifications, reload: reloadNotifications } = useApi<{
    items: NotificationRow[];
    unread: number;
  }>('/api/notifications?limit=8', { refreshInterval: 60_000 });

  const searchable = React.useMemo(
    () => visibleSections(sections, capabilities).flatMap((section) => section.items),
    [sections, capabilities],
  );

  const results = React.useMemo(() => {
    if (!query.trim()) return [];
    const needle = query.trim().toLowerCase();
    return searchable
      .filter((item) => item.label.toLowerCase().includes(needle))
      .slice(0, 6);
  }, [query, searchable]);

  async function markAllRead() {
    try {
      await api.post('/api/notifications/read-all');
      await reloadNotifications();
    } catch {
      toast.error('Could not update notifications');
    }
  }

  async function logout() {
    try {
      await api.post('/api/auth/logout', undefined, { skipRefresh: true });
    } finally {
      router.push('/login');
      router.refresh();
    }
  }

  const unread = notifications?.unread ?? 0;

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <button
        type="button"
        onClick={onOpenMobileNav}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-5" />
      </button>

      {/* Global search */}
      <div className="relative w-full max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSearchOpen(true);
          }}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
          placeholder="Search pages…"
          aria-label="Search pages"
          className="h-9 w-full rounded-md border border-input bg-card pl-8 pr-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {searchOpen && results.length > 0 ? (
          <div className="absolute left-0 top-11 z-40 w-full overflow-hidden rounded-md border border-border bg-popover p-1 shadow-lg">
            {results.map((item) => (
              <button
                key={item.href}
                type="button"
                onMouseDown={() => router.push(item.href)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <item.icon className="size-4 text-muted-foreground" />
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle className="hidden sm:inline-flex" />

        {/* Notifications */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
            >
              <Bell className="size-4" />
              {unread > 0 ? (
                <span className="absolute right-1 top-1 flex min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground">
                  {unread > 9 ? '9+' : unread}
                </span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <div className="flex items-center justify-between px-2 py-1.5">
              <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
              {unread > 0 ? (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Check className="size-3" /> Mark all read
                </button>
              ) : null}
            </div>
            <DropdownMenuSeparator />
            {(notifications?.items ?? []).length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                You are all caught up.
              </p>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {(notifications?.items ?? []).map((item) => (
                  <div
                    key={item.id}
                    className={cn(
                      'flex flex-col gap-1 rounded-sm px-2 py-2 text-sm',
                      !item.isRead && 'bg-muted/50',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <StatusBadge status={item.severity} />
                      <span className="truncate font-medium">{item.title}</span>
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{item.message}</p>
                  </div>
                ))}
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md p-0.5 pr-2 transition-colors hover:bg-muted"
              aria-label="Account menu"
            >
              <Avatar className="size-8">
                <AvatarFallback>{initialsOf(user.displayName ?? user.username)}</AvatarFallback>
              </Avatar>
              <span className="hidden text-sm font-medium sm:block">
                {user.displayName ?? user.username}
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <div className="px-2 py-1.5">
              <p className="truncate text-sm font-medium">{user.displayName ?? user.username}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <StatusBadge status={user.role} />
                <StatusBadge status={user.status} />
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/profile">
                <UserIcon /> My profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void logout()} className="text-destructive focus:text-destructive">
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

/** Mobile-only floating action used by the shell. */
export function MobileNavButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={onClick} aria-label="Open navigation">
      <Menu />
    </Button>
  );
}

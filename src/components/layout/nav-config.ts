import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  CreditCard,
  FileText,
  LayoutDashboard,
  LogIn,
  LogOut,
  Route,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Users,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import type { Capability } from '@/lib/auth/rbac';

/**
 * Navigation model.
 *
 * Each item declares the capability required to see it. The server passes the
 * caller's capability list into the shell; items they lack are simply not
 * rendered. (This is cosmetic — the API enforces the same rules.)
 */
export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Any one of these capabilities grants visibility. */
  requires?: Capability[];
  badgeKey?: 'servers' | 'users' | 'configs' | 'notifications';
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const ADMIN_NAV: NavSection[] = [
  {
    title: 'Overview',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, requires: ['monitoring:read'] },
      { label: 'Monitoring', href: '/monitoring', icon: Activity, requires: ['monitoring:read'], badgeKey: 'servers' },
      { label: 'Traffic', href: '/traffic', icon: BarChart3, requires: ['traffic:read'] },
    ],
  },
  {
    title: 'Infrastructure',
    items: [
      { label: 'Servers', href: '/servers', icon: Server, requires: ['servers:read'], badgeKey: 'servers' },
      { label: 'Configurations', href: '/configs', icon: ShieldCheck, requires: ['configs:read'], badgeKey: 'configs' },
      { label: 'Tunnels', href: '/tunnels', icon: Waypoints, requires: ['tunnels:read'] },
      { label: 'Inbounds', href: '/inbounds', icon: LogIn, requires: ['configs:read'] },
      { label: 'Outbounds', href: '/outbounds', icon: LogOut, requires: ['configs:read'] },
      { label: 'Routing', href: '/routing', icon: Route, requires: ['configs:read'] },
      { label: 'Reverse proxy', href: '/reverse-proxy', icon: ArrowLeftRight, requires: ['configs:read'] },
    ],
  },
  {
    title: 'Customers',
    items: [
      { label: 'Users', href: '/users', icon: Users, requires: ['users:read'], badgeKey: 'users' },
      { label: 'Subscriptions', href: '/subscriptions', icon: CreditCard, requires: ['subscriptions:read'] },
    ],
  },
  {
    title: 'System',
    items: [
      { label: 'Audit logs', href: '/logs', icon: ScrollText, requires: ['logs:read'] },
      { label: 'Settings', href: '/settings', icon: Settings, requires: ['settings:read'] },
      { label: 'My profile', href: '/profile', icon: FileText },
    ],
  },
];

export const USER_NAV: NavSection[] = [
  {
    title: 'My account',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      { label: 'My configurations', href: '/configs', icon: ShieldCheck },
      { label: 'My traffic', href: '/traffic', icon: BarChart3 },
      { label: 'My profile', href: '/profile', icon: FileText },
    ],
  },
];

export function visibleSections(sections: NavSection[], capabilities: Capability[]): NavSection[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) => !item.requires || item.requires.some((cap) => capabilities.includes(cap)),
      ),
    }))
    .filter((section) => section.items.length > 0);
}

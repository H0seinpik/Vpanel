'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen, ShieldCheck, X } from 'lucide-react';
import type { Capability } from '@/lib/auth/rbac';
import { cn } from '@/lib/utils';
import { visibleSections, type NavSection } from './nav-config';

/**
 * Sidebar navigation.
 *
 * Desktop: collapsible rail. Mobile: an off-canvas drawer driven by `open`.
 * Only sections/items the caller's capabilities permit are rendered.
 */
export function Sidebar({
  sections,
  capabilities,
  appName,
  open,
  onClose,
  collapsed,
  onToggleCollapsed,
}: {
  sections: NavSection[];
  capabilities: Capability[];
  appName: string;
  open: boolean;
  onClose: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const pathname = usePathname();
  const visible = React.useMemo(() => visibleSections(sections, capabilities), [sections, capabilities]);

  const content = (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className={cn('flex h-14 items-center gap-2 border-b border-white/10 px-4', collapsed && 'justify-center px-2')}>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-active">
          <ShieldCheck className="size-4 text-white" />
        </div>
        {!collapsed ? (
          <span className="truncate text-sm font-semibold text-sidebar-foreground">{appName}</span>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded p-1 text-sidebar-muted hover:text-sidebar-foreground lg:hidden"
          aria-label="Close navigation"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {visible.map((section) => (
          <div key={section.title} className="space-y-1">
            {!collapsed ? (
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-muted">
                {section.title}
              </p>
            ) : null}

            {section.items.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  title={collapsed ? item.label : undefined}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                    active
                      ? 'bg-sidebar-active/15 text-sidebar-foreground'
                      : 'text-sidebar-muted hover:bg-white/5 hover:text-sidebar-foreground',
                    collapsed && 'justify-center px-2',
                  )}
                >
                  <Icon
                    className={cn('size-4 shrink-0', active ? 'text-sidebar-active' : 'text-sidebar-muted group-hover:text-sidebar-foreground')}
                  />
                  {!collapsed ? <span className="truncate">{item.label}</span> : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Collapse control (desktop only) */}
      <div className="hidden border-t border-white/10 p-2 lg:block">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs text-sidebar-muted transition-colors hover:bg-white/5 hover:text-sidebar-foreground',
            collapsed && 'justify-center',
          )}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          {!collapsed ? <span>Collapse</span> : null}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop rail */}
      <aside
        className={cn(
          'hidden shrink-0 border-r border-black/20 bg-sidebar transition-[width] duration-200 lg:block',
          collapsed ? 'w-16' : 'w-60',
        )}
      >
        {content}
      </aside>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
          />
          <aside className="absolute inset-y-0 left-0 w-64 bg-sidebar shadow-xl">{content}</aside>
        </div>
      ) : null}
    </>
  );
}

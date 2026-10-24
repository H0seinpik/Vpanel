'use client';

import * as React from 'react';
import { RefreshCw, ScrollText } from 'lucide-react';
import { toQuery } from '@/lib/api-client';
import { useApi, useDebounced } from '@/hooks/use-api';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton, EmptyState } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { DataToolbar } from '@/components/common/data-toolbar';
import { Pagination, type PaginationMeta } from '@/components/common/pagination';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface AuditRow {
  id: string;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface LogsResponse {
  data: AuditRow[];
  pagination: PaginationMeta;
  filters: { actions: Array<{ action: string; count: number }> };
}

const SEVERITY_BY_PREFIX: Record<string, string> = {
  'auth.login_failed': 'CRITICAL',
  'user.delete': 'CRITICAL',
  'server.delete': 'CRITICAL',
  'config.delete': 'CRITICAL',
  'settings.security_update': 'WARNING',
};

/** Audit log viewer with filtering, pagination and a metadata inspector. */
export default function LogsPage() {
  const [search, setSearch] = React.useState('');
  const [action, setAction] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(30);
  const [detail, setDetail] = React.useState<AuditRow | null>(null);

  const debouncedSearch = useDebounced(search);
  const path = `/api/logs${toQuery({ search: debouncedSearch, action, page, pageSize })}`;
  const { data, loading, error, reload, refreshing } = useApi<LogsResponse>(path);

  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, action]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit logs"
        description="Every security-relevant and state-changing action is recorded here."
        actions={
          <Button variant="outline" size="sm" onClick={() => void reload()} loading={refreshing}>
            <RefreshCw /> Refresh
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <DataToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search action, actor, IP or target…"
          filters={[
            {
              key: 'action',
              label: 'Action',
              value: action,
              options: (data?.filters.actions ?? []).map((entry) => ({
                label: `${entry.action} (${entry.count})`,
                value: entry.action,
              })),
            },
          ]}
          onFilterChange={(key, value) => {
            if (key === 'action') setAction(value);
          }}
        />

        {loading && !data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-10" />
            ))}
          </div>
        ) : error ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium">Could not load logs</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        ) : (data?.data.length ?? 0) === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No log entries"
            description="Activity will appear here as soon as actions are performed."
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.data.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    onClick={() => setDetail(row)}
                  >
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm">{row.actorName ?? 'system'}</TableCell>
                    <TableCell>
                      <StatusBadge
                        status={SEVERITY_BY_PREFIX[row.action] ?? 'INFO'}
                        label={row.action}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.targetType ? (
                        <>
                          {row.targetType}
                          {row.targetId ? (
                            <span className="ml-1 font-mono">#{row.targetId.slice(-6)}</span>
                          ) : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.ip ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {data ? (
              <Pagination
                meta={data.pagination}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            ) : null}
          </>
        )}
      </Card>

      <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{detail?.action}</DialogTitle>
            <DialogDescription>{formatDateTime(detail?.createdAt)}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2 text-sm">
            <DetailRow label="Actor" value={detail?.actorName ?? 'system'} />
            <DetailRow label="Target" value={detail?.targetType ? `${detail.targetType} · ${detail.targetId ?? '—'}` : '—'} />
            <DetailRow label="IP address" value={detail?.ip ?? '—'} />
            <DetailRow label="User agent" value={detail?.userAgent ?? '—'} />
          </div>

          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Metadata
            </p>
            <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-[11px]">
              {JSON.stringify(detail?.metadata ?? {}, null, 2)}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border pb-2 last:border-0">
      <span className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="break-all text-right">{value}</span>
    </div>
  );
}

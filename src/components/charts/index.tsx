'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatBytes } from '@/lib/format';

/**
 * Chart components.
 *
 * Recharts requires the browser, so every chart is a client component. Colours
 * are pulled from the theme tokens so charts adapt to light/dark automatically.
 */

const CHART_COLORS = {
  primary: 'hsl(243 75% 59%)',
  accent: 'hsl(199 89% 48%)',
  success: 'hsl(142 71% 45%)',
  warning: 'hsl(32 95% 44%)',
  destructive: 'hsl(0 72% 51%)',
  muted: 'hsl(215 16% 47%)',
};

const AXIS_PROPS = {
  stroke: 'hsl(var(--muted-foreground))',
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

const TOOLTIP_STYLE = {
  contentStyle: {
    background: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: 8,
    fontSize: 12,
    color: 'hsl(var(--popover-foreground))',
  },
  labelStyle: { color: 'hsl(var(--muted-foreground))', fontSize: 11 },
} as const;

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', { month: 'short', day: '2-digit' });
}

/** Upload/download traffic over time (stacked areas). */
export function TrafficAreaChart({
  data,
  height = 260,
}: {
  data: { bucket: string; uploadBytes: number; downloadBytes: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="uploadFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART_COLORS.accent} stopOpacity={0.35} />
            <stop offset="95%" stopColor={CHART_COLORS.accent} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="downloadFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.35} />
            <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="bucket" tickFormatter={shortDate} {...AXIS_PROPS} />
        <YAxis tickFormatter={(value: number) => formatBytes(value, 0)} {...AXIS_PROPS} width={64} />
        <Tooltip
          {...TOOLTIP_STYLE}
          labelFormatter={(label: string) => shortDate(label)}
          formatter={(value: number, name: string) => [formatBytes(value), name === 'uploadBytes' ? 'Upload' : 'Download']}
        />
        <Legend
          formatter={(value: string) => (value === 'uploadBytes' ? 'Upload' : 'Download')}
          wrapperStyle={{ fontSize: 12 }}
        />
        <Area
          type="monotone"
          dataKey="downloadBytes"
          stackId="1"
          stroke={CHART_COLORS.primary}
          fill="url(#downloadFill)"
          strokeWidth={2}
        />
        <Area
          type="monotone"
          dataKey="uploadBytes"
          stackId="1"
          stroke={CHART_COLORS.accent}
          fill="url(#uploadFill)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Active users over time (line). */
export function ActiveUsersChart({
  data,
  height = 220,
}: {
  data: { bucket: string; count: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="bucket" tickFormatter={shortDate} {...AXIS_PROPS} />
        <YAxis allowDecimals={false} {...AXIS_PROPS} width={36} />
        <Tooltip
          {...TOOLTIP_STYLE}
          labelFormatter={(label: string) => shortDate(label)}
          formatter={(value: number) => [value, 'Active users']}
        />
        <Line
          type="monotone"
          dataKey="count"
          stroke={CHART_COLORS.success}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Horizontal ranking bars (traffic by server / by user). */
export function RankingBarChart({
  data,
  height = 280,
  color = CHART_COLORS.primary,
}: {
  data: { label: string; totalBytes: number }[];
  height?: number;
  color?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
        <XAxis type="number" tickFormatter={(value: number) => formatBytes(value, 0)} {...AXIS_PROPS} />
        <YAxis type="category" dataKey="label" width={120} {...AXIS_PROPS} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => [formatBytes(value), 'Traffic']} />
        <Bar dataKey="totalBytes" fill={color} radius={[0, 4, 4, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: CHART_COLORS.success,
  ONLINE: CHART_COLORS.success,
  DISABLED: CHART_COLORS.muted,
  EXPIRED: CHART_COLORS.warning,
  WARNING: CHART_COLORS.warning,
  TRAFFIC_EXCEEDED: CHART_COLORS.destructive,
  OFFLINE: CHART_COLORS.destructive,
  SUSPENDED: CHART_COLORS.destructive,
  PENDING: CHART_COLORS.accent,
};

/** Donut for status distributions. */
export function StatusDonutChart({
  data,
  height = 240,
}: {
  data: { status: string; count: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="count"
          nameKey="status"
          innerRadius={55}
          outerRadius={85}
          paddingAngle={2}
          stroke="hsl(var(--card))"
          strokeWidth={2}
        >
          {data.map((entry) => (
            <Cell key={entry.status} fill={STATUS_COLORS[entry.status] ?? CHART_COLORS.accent} />
          ))}
        </Pie>
        <Tooltip {...TOOLTIP_STYLE} formatter={(value: number, name: string) => [value, name]} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

/** Tiny inline sparkline for monitoring rows. */
export function Sparkline({
  data,
  dataKey = 'cpuPercent',
  color = CHART_COLORS.primary,
  height = 40,
}: {
  data: Record<string, unknown>[];
  dataKey?: string;
  color?: string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
        <defs>
          <linearGradient id={`spark-${dataKey}-${color.replace(/[^a-z0-9]/gi, '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.4} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#spark-${dataKey}-${color.replace(/[^a-z0-9]/gi, '')})`}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

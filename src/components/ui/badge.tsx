import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/10 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        success: 'border-transparent bg-success/12 text-success',
        warning: 'border-transparent bg-warning/15 text-warning',
        destructive: 'border-transparent bg-destructive/12 text-destructive',
        outline: 'border-border text-muted-foreground',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Maps domain statuses onto badge variants so colours stay consistent app-wide. */
const STATUS_VARIANTS: Record<string, NonNullable<BadgeProps['variant']>> = {
  // Server / user / config lifecycle
  ACTIVE: 'success',
  ONLINE: 'success',
  EXPIRED: 'warning',
  WARNING: 'warning',
  TRAFFIC_EXCEEDED: 'destructive',
  DISABLED: 'muted',
  SUSPENDED: 'destructive',
  OFFLINE: 'destructive',
  PENDING: 'secondary',
  ARCHIVED: 'muted',
  CANCELLED: 'muted',
  REVOKED: 'muted',
  BLOCKED: 'destructive',
  // Severities
  INFO: 'default',
  CRITICAL: 'destructive',
  // Roles
  ADMIN: 'default',
  OPERATOR: 'secondary',
  USER: 'outline',
};

export function StatusBadge({
  status,
  className,
  label,
}: {
  status: string;
  className?: string;
  label?: string;
}) {
  const variant = STATUS_VARIANTS[status] ?? 'outline';
  return (
    <Badge variant={variant} className={className}>
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          variant === 'success' && 'bg-success',
          variant === 'warning' && 'bg-warning',
          variant === 'destructive' && 'bg-destructive',
          variant === 'default' && 'bg-primary',
          variant === 'secondary' && 'bg-muted-foreground',
          variant === 'muted' && 'bg-muted-foreground',
          variant === 'outline' && 'bg-muted-foreground',
        )}
      />
      {label ?? status.replace(/_/g, ' ')}
    </Badge>
  );
}

export { Badge, badgeVariants };

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { statusVariant, type StatusKind, type StatusVariant } from '@/lib/status';

type StatusBadgeProps = Omit<React.ComponentProps<typeof Badge>, 'variant'> & {
  /** Status domain — drives the value → variant mapping. */
  kind: StatusKind;
  /** Raw status value (e.g. "running", "healthy", "failed"). */
  value: string | null | undefined;
  /** Display label; defaults to the raw value. */
  label?: React.ReactNode;
  /** Render a leading status dot in the badge's text color. */
  dot?: boolean;
  /** Force a variant, bypassing the kind/value mapping. */
  variant?: StatusVariant;
};

/**
 * Status pill bound to the Deep Slate tokens. Single replacement for the
 * scattered `getXStatusColor()` + `badge-*` class usage (#244 / review S3):
 * `<StatusBadge kind="health" value={server.health} dot />`.
 */
export function StatusBadge({
  kind,
  value,
  label,
  dot = false,
  variant,
  className,
  ...props
}: StatusBadgeProps) {
  const resolved = variant ?? statusVariant(kind, value);
  return (
    <Badge variant={resolved} className={cn('gap-1.5', className)} {...props}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {label ?? value ?? 'unknown'}
    </Badge>
  );
}

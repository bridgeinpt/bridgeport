import * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type EmptyStateButtonVariant =
  | 'default'
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'outline'
  | 'destructive';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  /** `primary` is accepted as a legacy alias for `default`. */
  variant?: EmptyStateButtonVariant;
}

interface EmptyStateProps {
  /** Icon component (lucide or compatible). */
  icon?: React.ComponentType<{ className?: string }>;
  message: string;
  description?: string;
  action?: EmptyStateAction;
  children?: React.ReactNode;
  className?: string;
}

/**
 * Centered empty state on shadcn + tokens (#244). Drop-in for the legacy
 * `@/components/EmptyState` — same prop shape, including the `primary` action
 * alias — so pages migrate by swapping the import.
 */
export function EmptyState({
  icon: Icon,
  message,
  description,
  action,
  children,
  className,
}: EmptyStateProps) {
  const buttonVariant = action?.variant === 'primary' ? 'default' : action?.variant ?? 'default';

  return (
    <div
      className={cn(
        'rounded-lg border border-dashed border-border bg-card/40 px-6 py-12 text-center',
        className
      )}
    >
      {Icon && <Icon className="mx-auto mb-4 size-12 text-muted-foreground" />}
      <p className="text-sm text-foreground">{message}</p>
      {description && <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
      {action && (
        <Button variant={buttonVariant} onClick={action.onClick} className="mt-4">
          {action.label}
        </Button>
      )}
      {children}
    </div>
  );
}

export default EmptyState;

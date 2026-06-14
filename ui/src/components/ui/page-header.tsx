import * as React from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  /** Section title. Rendered as an `<h2>` — page-level titles stay in the breadcrumb. */
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned actions (buttons, menus). */
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Title + description + actions row (#244). Deliberately uses `<h2>` (never
 * `<h1>`) to honor the "breadcrumbs own the page title" rule.
 */
export function PageHeader({ title, description, actions, className, children }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

interface SectionProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

/** Grouped content block with an optional header row. */
export function Section({ title, description, actions, className, children }: SectionProps) {
  return (
    <section className={cn('space-y-4', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            {title && <h3 className="text-base font-semibold text-foreground">{title}</h3>}
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Lightweight bordered container (token-based replacement for legacy `.panel`). */
export function Panel({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border bg-card p-4', className)} {...props} />;
}

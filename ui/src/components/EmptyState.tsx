import { ReactNode, ComponentType } from 'react';

interface IconProps {
  className?: string;
}

interface EmptyStateProps {
  /** Icon component to display */
  icon?: ComponentType<IconProps>;
  /** Main message to display */
  message: string;
  /** Optional secondary description */
  description?: string;
  /** Optional action button */
  action?: {
    label: string;
    onClick: () => void;
    variant?: 'primary' | 'secondary' | 'ghost';
  };
  /** Additional content below the action */
  children?: ReactNode;
}

/**
 * Reusable empty state component for when no data is available.
 * Displays a centered message with optional icon, description, and action button.
 */
export function EmptyState({
  icon: Icon,
  message,
  description,
  action,
  children,
}: EmptyStateProps): JSX.Element {
  const buttonVariantClass = action?.variant === 'secondary'
    ? 'btn btn-secondary'
    : action?.variant === 'ghost'
    ? 'btn btn-ghost'
    : 'btn btn-primary';

  return (
    <div className="panel text-center py-12">
      {Icon && <Icon className="w-12 h-12 text-slate-500 mx-auto mb-4" />}
      <p className="text-slate-400">{message}</p>
      {description && (
        <p className="text-slate-500 text-sm mt-2">{description}</p>
      )}
      {action && (
        <button onClick={action.onClick} className={`${buttonVariantClass} mt-4`}>
          {action.label}
        </button>
      )}
      {children}
    </div>
  );
}

export default EmptyState;

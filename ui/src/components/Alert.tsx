import { ReactNode } from 'react';
import { CheckIcon, WarningIcon, InfoIcon } from './Icons';

type AlertVariant = 'error' | 'warning' | 'success' | 'info';

interface AlertProps {
  variant: AlertVariant;
  title?: string;
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

const variantStyles: Record<AlertVariant, string> = {
  error: 'alert-error',
  warning: 'alert-warning',
  success: 'alert-success',
  info: 'alert-info',
};

const variantIcons: Record<AlertVariant, React.ComponentType<{ className?: string }>> = {
  error: WarningIcon,
  warning: WarningIcon,
  success: CheckIcon,
  info: InfoIcon,
};

/**
 * Consistent alert component for displaying messages, errors, and notifications.
 * Replaces inconsistent inline alert styling across the application.
 */
export function Alert({
  variant,
  title,
  children,
  onDismiss,
  className = '',
}: AlertProps) {
  const Icon = variantIcons[variant];

  return (
    <div className={`alert ${variantStyles[variant]} ${className}`} role="alert">
      <div className="flex items-start gap-3">
        <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          {title && <p className="font-medium">{title}</p>}
          <div className={title ? 'mt-1' : ''}>{children}</div>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="flex-shrink-0 p-1 -mr-1 hover:opacity-70 transition-opacity"
            aria-label="Dismiss alert"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

export default Alert;

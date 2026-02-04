import { ReactNode } from 'react';

interface LoadingSkeletonProps {
  /** Number of skeleton rows to display */
  rows?: number;
  /** Height class for each row (default: h-20) */
  rowHeight?: string;
  /** Optional header element to show above skeleton rows */
  header?: ReactNode;
  /** Width class for the header (default: w-32) */
  headerWidth?: string;
}

/**
 * Reusable loading skeleton for page content.
 * Displays animated placeholder shapes while content is loading.
 */
export function LoadingSkeleton({
  rows = 3,
  rowHeight = 'h-20',
  header,
  headerWidth = 'w-32',
}: LoadingSkeletonProps): JSX.Element {
  return (
    <div className="p-6">
      <div className="animate-pulse">
        {header ?? <div className={`h-7 ${headerWidth} bg-slate-700 rounded mb-5`}></div>}
        <div className="space-y-4">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className={`${rowHeight} bg-slate-800 rounded-lg`}></div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default LoadingSkeleton;

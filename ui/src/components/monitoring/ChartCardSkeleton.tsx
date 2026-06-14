import { memo } from 'react';
import { Card } from '@/components/ui/card';
import RefreshingDot from './RefreshingDot';

/**
 * Card-shaped skeleton used while a metric card's initial data is loading.
 * Matches the outer chrome of `ChartCard` (card class, title height, 220px
 * chart body) so swapping to the loaded chart doesn't shift the page layout.
 *
 * `refreshing` shows a small spinner badge in the top-right when the card
 * is already populated but the next delta is in flight — used only by the
 * combined "loaded + refreshing" branch in ChartCard itself.
 */
export interface ChartCardSkeletonProps {
  title?: string;
  refreshing?: boolean;
}

const ChartCardSkeleton = memo(function ChartCardSkeleton({ title, refreshing }: ChartCardSkeletonProps) {
  return (
    <Card className="relative p-4" data-testid="chart-card-skeleton">
      <div className="flex items-center justify-between mb-4">
        {title ? (
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
        ) : (
          <div className="h-4 w-24 bg-muted rounded animate-pulse" />
        )}
        {refreshing && <RefreshingDot />}
      </div>
      <div className="h-56 animate-pulse bg-muted/50 rounded" />
    </Card>
  );
});

export default ChartCardSkeleton;

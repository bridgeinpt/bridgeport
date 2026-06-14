/**
 * Small ring-style spinner used as the "refreshing" badge in the top-right
 * corner of monitoring chart cards. Extracted so the three call sites (loaded
 * state in ChartCard, empty state in ChartCard, ChartCardSkeleton) share one
 * definition. The global `SpinnerIcon` in components/Icons.tsx uses a
 * filled-arc SVG that reads muddy at this 12px size, so we keep the
 * border-ring variant here.
 */
export default function RefreshingDot() {
  return (
    <span
      className="inline-block w-3 h-3 border-2 border-muted border-t-brand rounded-full animate-spin"
      aria-label="Refreshing"
      role="status"
    />
  );
}

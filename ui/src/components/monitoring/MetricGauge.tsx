import { memo } from 'react';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { metricSeverity } from '@/lib/status';

export interface MetricGaugeProps {
  label: string;
  value?: number;
  displayValue?: string;
  max: number;
  unit?: string;
  color?: 'primary' | 'green' | 'yellow' | 'purple';
  /** Warn / critical thresholds (same unit as `value`). When both are set, the
   *  bar color reflects severity (danger zones) instead of the static `color`. */
  warn?: number;
  crit?: number;
}

// Full static class strings (Tailwind can't see dynamically-built ones).
const COLOR_INDICATOR = {
  primary: '[&>[data-slot=progress-indicator]]:bg-primary',
  green: '[&>[data-slot=progress-indicator]]:bg-success',
  yellow: '[&>[data-slot=progress-indicator]]:bg-warning',
  purple: '[&>[data-slot=progress-indicator]]:bg-chart-4',
} as const;

const SEVERITY_INDICATOR = {
  normal: '[&>[data-slot=progress-indicator]]:bg-success',
  warning: '[&>[data-slot=progress-indicator]]:bg-warning',
  critical: '[&>[data-slot=progress-indicator]]:bg-destructive',
} as const;

const MetricGauge = memo(function MetricGauge({
  label,
  value,
  displayValue,
  max,
  unit,
  color = 'primary',
  warn,
  crit,
}: MetricGaugeProps) {
  const percentage = value != null ? Math.min((value / max) * 100, 100) : 0;
  const useSeverity = value != null && warn != null && crit != null;
  const indicatorClass = useSeverity
    ? SEVERITY_INDICATOR[metricSeverity(value, warn, crit)]
    : COLOR_INDICATOR[color];

  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="mb-2 text-xs text-muted-foreground">{label}</p>
      <p className="mb-3 text-2xl font-bold text-foreground">
        {displayValue ?? (value != null ? value.toFixed(1) : '-')}
        {!displayValue && unit && value != null && <span className="text-sm text-muted-foreground">{unit}</span>}
      </p>
      <Progress
        value={percentage}
        aria-label={label}
        className={cn('h-2', indicatorClass)}
      />
    </div>
  );
});

export default MetricGauge;

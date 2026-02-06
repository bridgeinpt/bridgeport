import { memo } from 'react';

export interface MetricGaugeProps {
  label: string;
  value?: number;
  displayValue?: string;
  max: number;
  unit?: string;
  color: 'primary' | 'green' | 'yellow' | 'purple';
}

const GAUGE_COLOR_CLASSES = {
  primary: 'bg-primary-500',
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  purple: 'bg-purple-500',
} as const;

const GAUGE_BG_COLOR_CLASSES = {
  primary: 'bg-primary-900/30',
  green: 'bg-green-900/30',
  yellow: 'bg-yellow-900/30',
  purple: 'bg-purple-900/30',
} as const;

const MetricGauge = memo(function MetricGauge({ label, value, displayValue, max, unit, color }: MetricGaugeProps) {
  const percentage = value != null ? Math.min((value / max) * 100, 100) : 0;

  return (
    <div className={`p-4 rounded-lg ${GAUGE_BG_COLOR_CLASSES[color]}`}>
      <p className="text-slate-400 text-xs mb-2">{label}</p>
      <p className="text-2xl font-bold text-white mb-3">
        {displayValue ?? (value != null ? value.toFixed(1) : '-')}
        {!displayValue && unit && value != null && (
          <span className="text-sm text-slate-400">{unit}</span>
        )}
      </p>
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${GAUGE_COLOR_CLASSES[color]}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
});

export default MetricGauge;

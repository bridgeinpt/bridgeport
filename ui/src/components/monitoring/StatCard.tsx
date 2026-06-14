import { memo } from 'react';

export interface StatCardProps {
  label: string;
  value: string | number;
  color: 'blue' | 'green' | 'emerald' | 'red' | 'slate';
}

// Semantic theme tokens so KPI cards adapt to light/dark (info/success/destructive/neutral).
const STAT_COLOR_CLASSES = {
  blue: 'bg-info/10 border-info/30',
  green: 'bg-success/10 border-success/30',
  emerald: 'bg-success/10 border-success/30',
  red: 'bg-destructive/10 border-destructive/30',
  slate: 'bg-muted border-border',
} as const;

const STAT_TEXT_COLORS = {
  blue: 'text-info',
  green: 'text-success',
  emerald: 'text-success',
  red: 'text-destructive',
  slate: 'text-muted-foreground',
} as const;

const StatCard = memo(function StatCard({ label, value, color }: StatCardProps) {
  return (
    <div className={`rounded-xl border p-4 ${STAT_COLOR_CLASSES[color]}`}>
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${STAT_TEXT_COLORS[color]}`}>{value}</p>
    </div>
  );
});

export default StatCard;

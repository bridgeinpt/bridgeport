import { memo } from 'react';

export interface StatCardProps {
  label: string;
  value: string | number;
  color: 'blue' | 'green' | 'emerald' | 'red' | 'slate';
}

const STAT_COLOR_CLASSES = {
  blue: 'bg-blue-500/10 border-blue-500/30',
  green: 'bg-green-500/10 border-green-500/30',
  emerald: 'bg-emerald-500/10 border-emerald-500/30',
  red: 'bg-red-500/10 border-red-500/30',
  slate: 'bg-slate-500/10 border-slate-500/30',
} as const;

const STAT_TEXT_COLORS = {
  blue: 'text-blue-400',
  green: 'text-green-400',
  emerald: 'text-emerald-400',
  red: 'text-red-400',
  slate: 'text-slate-400',
} as const;

const StatCard = memo(function StatCard({ label, value, color }: StatCardProps) {
  return (
    <div className={`rounded-xl border p-4 ${STAT_COLOR_CLASSES[color]}`}>
      <p className="text-slate-400 text-xs mb-1">{label}</p>
      <p className={`text-2xl font-bold ${STAT_TEXT_COLORS[color]}`}>{value}</p>
    </div>
  );
});

export default StatCard;

import { memo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import ChartCardSkeleton from './ChartCardSkeleton';
import RefreshingDot from './RefreshingDot';

const COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#f87171'];

export interface ChartCardProps {
  title: string;
  data: Record<string, unknown>[];
  names: string[];
  formatTime: (time: string) => string;
  unit?: string;
  domain?: [number | 'auto', number | 'auto'];
  // Issue #171 — per-card loading states. `loading` renders the inline
  // skeleton (used during the card's first fetch). `refreshing` shows a
  // small spinner in the corner while a delta-refresh is in flight so the
  // existing chart stays visible.
  loading?: boolean;
  refreshing?: boolean;
}

const ChartCard = memo(function ChartCard({ title, data, names, formatTime, unit, domain, loading, refreshing }: ChartCardProps) {
  // While the card is doing its initial load, render the matching skeleton
  // in place so the rest of the page chrome can paint without waiting on
  // any one card's data.
  if (loading) {
    return <ChartCardSkeleton title={title} />;
  }

  if (data.length === 0) {
    return (
      <div className="card relative">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-white">{title}</h3>
          {refreshing && <RefreshingDot />}
        </div>
        <div className="h-56 flex items-center justify-center text-slate-500">
          No data available
        </div>
      </div>
    );
  }

  return (
    <div className="card relative">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-white">{title}</h3>
        {refreshing && (
          <span
            className="inline-block w-3 h-3 border-2 border-slate-600 border-t-brand-400 rounded-full animate-spin"
            aria-label="Refreshing"
          />
        )}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <XAxis
            dataKey="time"
            tickFormatter={formatTime}
            tick={{ fill: '#64748b', fontSize: 11 }}
            axisLine={{ stroke: '#334155' }}
            tickLine={{ stroke: '#334155' }}
          />
          <YAxis
            domain={domain}
            tick={{ fill: '#64748b', fontSize: 11 }}
            axisLine={{ stroke: '#334155' }}
            tickLine={{ stroke: '#334155' }}
            tickFormatter={(v) => `${v}${unit || ''}`}
            width={50}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '8px',
            }}
            labelFormatter={(label) => formatTime(String(label))}
            formatter={(value: unknown) => [`${Number(value).toFixed(1)}${unit || ''}`, '']}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {names.map((name, i) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
              name={name}
              stroke={COLORS[i % COLORS.length]}
              dot={false}
              strokeWidth={2}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
});

export default ChartCard;
export { COLORS };

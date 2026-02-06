import { memo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

const COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#f87171'];

export interface ChartCardProps {
  title: string;
  data: Record<string, unknown>[];
  names: string[];
  formatTime: (time: string) => string;
  unit?: string;
  domain?: [number | 'auto', number | 'auto'];
}

const ChartCard = memo(function ChartCard({ title, data, names, formatTime, unit, domain }: ChartCardProps) {
  if (data.length === 0) {
    return (
      <div className="card">
        <h3 className="text-sm font-medium text-white mb-4">{title}</h3>
        <div className="h-56 flex items-center justify-center text-slate-500">
          No data available
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="text-sm font-medium text-white mb-4">{title}</h3>
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
            labelFormatter={formatTime}
            formatter={(value: number) => [`${value?.toFixed(1)}${unit || ''}`, '']}
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

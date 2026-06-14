import { memo } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Card } from '@/components/ui/card';
import ChartCardSkeleton from './ChartCardSkeleton';
import RefreshingDot from './RefreshingDot';

// Series colors come from the Deep Slate chart palette (--chart-1..5).
const CHART_VARS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

export interface ChartCardProps {
  title: string;
  data: Record<string, unknown>[];
  names: string[];
  formatTime: (time: string) => string;
  unit?: string;
  domain?: [number | 'auto', number | 'auto'];
  // Per-card loading states (#171). `loading` renders the inline skeleton on
  // first fetch; `refreshing` shows a small spinner while a delta-refresh is in
  // flight so the existing chart stays visible.
  loading?: boolean;
  refreshing?: boolean;
}

const ChartCard = memo(function ChartCard({
  title,
  data,
  names,
  formatTime,
  unit,
  domain,
  loading,
  refreshing,
}: ChartCardProps) {
  if (loading) {
    return <ChartCardSkeleton title={title} />;
  }

  if (data.length === 0) {
    return (
      <Card className="relative p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {refreshing && <RefreshingDot />}
        </div>
        <div className="flex h-56 items-center justify-center text-muted-foreground">No data available</div>
      </Card>
    );
  }

  const config: ChartConfig = Object.fromEntries(
    names.map((name, i) => [name, { label: name, color: CHART_VARS[i % CHART_VARS.length] }])
  );

  return (
    <Card className="relative p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {refreshing && <RefreshingDot />}
      </div>
      <ChartContainer config={config} className="h-56 w-full">
        <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="time" tickFormatter={formatTime} tickLine={false} axisLine={false} fontSize={11} />
          <YAxis
            domain={domain}
            tickFormatter={(v) => `${v}${unit || ''}`}
            tickLine={false}
            axisLine={false}
            width={50}
            fontSize={11}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => formatTime(String(label))}
                formatter={(value) => `${Number(value).toFixed(1)}${unit || ''}`}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          {names.map((name, i) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
              name={name}
              stroke={CHART_VARS[i % CHART_VARS.length]}
              dot={false}
              strokeWidth={2}
              connectNulls
            />
          ))}
        </LineChart>
      </ChartContainer>
    </Card>
  );
});

export default ChartCard;

import { Button } from '@/components/ui/button';

const timeRanges = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

interface TimeRangeSelectorProps {
  value: number;
  onChange: (hours: number) => void;
}

export default function TimeRangeSelector({ value, onChange }: TimeRangeSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Time Range:</span>
      <div className="flex overflow-hidden rounded-md border">
        {timeRanges.map((range) => {
          const active = value === range.hours;
          return (
            <Button
              key={range.hours}
              type="button"
              variant={active ? 'default' : 'ghost'}
              size="sm"
              aria-pressed={active}
              className="rounded-none border-0"
              onClick={() => onChange(range.hours)}
            >
              {range.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

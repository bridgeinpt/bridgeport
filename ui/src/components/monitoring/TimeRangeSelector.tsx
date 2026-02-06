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
      <span className="text-sm text-slate-400">Time Range:</span>
      <div className="flex rounded-lg overflow-hidden border border-slate-600">
        {timeRanges.map((range) => (
          <button
            key={range.hours}
            onClick={() => onChange(range.hours)}
            className={`px-3 py-1.5 text-sm ${
              value === range.hours
                ? 'bg-brand-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            {range.label}
          </button>
        ))}
      </div>
    </div>
  );
}

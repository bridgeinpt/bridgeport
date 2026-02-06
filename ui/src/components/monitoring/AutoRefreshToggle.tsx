interface AutoRefreshToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  onRefresh: () => void;
  refreshing?: boolean;
}

export default function AutoRefreshToggle({ enabled, onChange, onRefresh, refreshing }: AutoRefreshToggleProps) {
  return (
    <div className="flex items-center gap-3">
      <label className="flex items-center gap-2 text-sm text-slate-400">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked)}
          className="rounded bg-slate-700 border-slate-600"
        />
        Auto: 30s
      </label>
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="btn btn-secondary"
      >
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  );
}

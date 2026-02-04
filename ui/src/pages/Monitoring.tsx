import { useEffect, useState, useMemo, useCallback, memo } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getEnvironmentMetricsSummary,
  getMetricsHistory,
  getMonitoringOverview,
  type MetricsSummaryServer,
  type ServiceMetrics,
  type MetricsHistoryServer,
  type MonitoringOverviewStats,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

const timeRanges = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

const COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#f87171'];

function parseTags(tagsJson: string): string[] {
  if (!tagsJson) return [];
  try {
    return JSON.parse(tagsJson);
  } catch {
    return [];
  }
}

export default function Monitoring() {
  const { selectedEnvironment, monitoringTimeRange, setMonitoringTimeRange, autoRefreshEnabled, setAutoRefreshEnabled, monitoringTagFilter, setMonitoringTagFilter } = useAppStore();
  const [servers, setServers] = useState<MetricsSummaryServer[]>([]);
  const [metricsHistory, setMetricsHistory] = useState<MetricsHistoryServer[]>([]);
  const [stats, setStats] = useState<MonitoringOverviewStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async (isRefresh = false) => {
    if (!selectedEnvironment?.id) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const [summaryRes, historyRes, overviewRes] = await Promise.all([
        getEnvironmentMetricsSummary(selectedEnvironment.id),
        getMetricsHistory(selectedEnvironment.id, monitoringTimeRange),
        getMonitoringOverview(selectedEnvironment.id),
      ]);
      setServers(summaryRes.servers);
      setMetricsHistory(historyRes.servers);
      setStats(overviewRes.stats);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [selectedEnvironment?.id, monitoringTimeRange]);

  // Auto-refresh every 30 seconds if enabled
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const interval = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(interval);
  }, [selectedEnvironment?.id, monitoringTimeRange, autoRefreshEnabled]);

  // Collect unique tags from all servers
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    servers.forEach((server) => {
      parseTags(server.tags).forEach((tag) => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [servers]);

  // Convert tag filter to Set for O(1) lookups
  const tagFilterSet = useMemo(() => new Set(monitoringTagFilter), [monitoringTagFilter]);

  // Filter servers and metrics history based on selected tags
  const filteredServers = useMemo(() => {
    if (tagFilterSet.size === 0) return servers;
    return servers.filter((server) => {
      const serverTags = parseTags(server.tags);
      return serverTags.some((tag) => tagFilterSet.has(tag));
    });
  }, [servers, tagFilterSet]);

  const filteredMetricsHistory = useMemo(() => {
    if (tagFilterSet.size === 0) return metricsHistory;
    return metricsHistory.filter((server) => {
      const serverTags = parseTags(server.tags);
      return serverTags.some((tag) => tagFilterSet.has(tag));
    });
  }, [metricsHistory, tagFilterSet]);

  // Stable callback for tag toggle to avoid creating new closures on each render
  const handleTagToggle = useCallback(
    (tag: string) => {
      const newFilter = monitoringTagFilter.includes(tag)
        ? monitoringTagFilter.filter((t) => t !== tag)
        : [...monitoringTagFilter, tag];
      setMonitoringTagFilter(newFilter);
    },
    [monitoringTagFilter, setMonitoringTagFilter]
  );

  // Prepare chart data - combine all servers into single timeline
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prepareChartData = (metric: 'cpu' | 'memory' | 'disk' | 'load'): any[] => {
    const timeMap = new Map<string, { time: string; [key: string]: string | number | null }>();

    filteredMetricsHistory.forEach((server) => {
      server.data.forEach((point) => {
        if (!timeMap.has(point.time)) {
          timeMap.set(point.time, { time: point.time });
        }
        const entry = timeMap.get(point.time)!;
        if (metric === 'cpu') entry[server.name] = point.cpu ?? null;
        else if (metric === 'memory') entry[server.name] = point.memory ?? null;
        else if (metric === 'disk') entry[server.name] = point.disk ?? null;
        else if (metric === 'load') entry[server.name] = point.load1 ?? null;
      });
    });

    return Array.from(timeMap.values()).sort((a, b) =>
      a.time.localeCompare(b.time)
    );
  };

  const formatTime = (time: string) => {
    const date = new Date(time);
    if (monitoringTimeRange <= 6) {
      return format(date, 'HH:mm');
    } else if (monitoringTimeRange <= 24) {
      return format(date, 'HH:mm');
    } else {
      return format(date, 'MMM d HH:mm');
    }
  };

  // Collect all services with metrics for the table (using filtered servers)
  const servicesWithMetrics = useMemo(() => {
    const services: Array<{
      id: string;
      name: string;
      serverName: string;
      serverId: string;
      metrics: ServiceMetrics;
    }> = [];

    filteredServers.forEach((server) => {
      server.services.forEach((service) => {
        if (service.latestMetrics) {
          services.push({
            id: service.id,
            name: service.name,
            serverName: server.name,
            serverId: server.id,
            metrics: service.latestMetrics,
          });
        }
      });
    });

    // Sort by CPU usage descending (copy array to avoid mutation)
    return [...services].sort((a, b) => (b.metrics.cpuPercent || 0) - (a.metrics.cpuPercent || 0));
  }, [filteredServers]);

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-8"></div>
          <div className="grid grid-cols-4 gap-4 mb-8">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-64 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const serversWithMetrics = filteredServers.filter((s) => s.latestMetrics);
  const serverNames = filteredMetricsHistory.map((s) => s.name);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-white">Monitoring Overview</h1>
          <p className="text-slate-400 text-sm mt-1">
            Resource usage across {selectedEnvironment?.name || 'environment'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={autoRefreshEnabled}
              onChange={(e) => setAutoRefreshEnabled(e.target.checked)}
              className="rounded bg-slate-700 border-slate-600"
            />
            Auto: 30s
          </label>
          <button
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="btn btn-secondary"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Quick Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Servers"
            value={stats.servers.total}
            color="blue"
          />
          <StatCard
            label="Services"
            value={stats.services.total}
            color="green"
          />
          <StatCard
            label="Healthy"
            value={`${stats.servers.healthy + stats.services.healthy}/${stats.servers.total + stats.services.total}`}
            color="emerald"
          />
          <StatCard
            label="Alerts"
            value={stats.alerts}
            color={stats.alerts > 0 ? 'red' : 'slate'}
          />
        </div>
      )}

      {/* Time Range and Tag Filter */}
      <div className="flex items-center flex-wrap gap-4 mb-6">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-400">Time Range:</span>
          <div className="flex rounded-lg overflow-hidden border border-slate-600">
            {timeRanges.map((range) => (
              <button
                key={range.hours}
                onClick={() => setMonitoringTimeRange(range.hours)}
                className={`px-3 py-1.5 text-sm ${
                  monitoringTimeRange === range.hours
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>

        {allTags.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Tags:</span>
            <div className="flex flex-wrap gap-1">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => handleTagToggle(tag)}
                  className={`px-2 py-1 text-xs rounded-full transition-colors ${
                    tagFilterSet.has(tag)
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {tag}
                </button>
              ))}
              {tagFilterSet.size > 0 && (
                <button
                  onClick={() => setMonitoringTagFilter([])}
                  className="px-2 py-1 text-xs rounded-full bg-slate-800 text-slate-400 hover:bg-slate-700"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Charts */}
      {filteredMetricsHistory.length > 0 && filteredMetricsHistory.some((s) => s.data.length > 0) ? (
        <div className="grid grid-cols-2 gap-6 mb-8">
          <ChartCard title="CPU Usage" data={prepareChartData('cpu')} serverNames={serverNames} formatTime={formatTime} unit="%" domain={[0, 100]} />
          <ChartCard title="Memory Usage" data={prepareChartData('memory')} serverNames={serverNames} formatTime={formatTime} unit="%" domain={[0, 100]} />
          <ChartCard title="Disk Usage" data={prepareChartData('disk')} serverNames={serverNames} formatTime={formatTime} unit="%" domain={[0, 100]} />
          <ChartCard title="Load Average" data={prepareChartData('load')} serverNames={serverNames} formatTime={formatTime} domain={[0, 'auto']} />
        </div>
      ) : (
        <div className="card text-center py-8 mb-8">
          <p className="text-slate-400">No historical metrics data available</p>
          <p className="text-slate-500 text-sm mt-1">
            Metrics will appear here as they are collected
          </p>
        </div>
      )}

      {/* Current Server Metrics */}
      {serversWithMetrics.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-4">Current Server Metrics</h2>
          <div className="space-y-4">
            {serversWithMetrics.map((server) => (
              <div key={server.id} className="card">
                <div className="flex items-center justify-between mb-4">
                  <Link
                    to={`/servers/${server.id}`}
                    className="text-lg font-semibold text-white hover:text-brand-400"
                  >
                    {server.name}
                  </Link>
                  <span className="text-xs text-slate-500">
                    {server.latestMetrics &&
                      formatDistanceToNow(new Date(server.latestMetrics.collectedAt), {
                        addSuffix: true,
                      })}
                  </span>
                </div>

                <div className="grid grid-cols-4 gap-4">
                  <MetricGauge
                    label="CPU"
                    value={server.latestMetrics?.cpuPercent ?? undefined}
                    max={100}
                    unit="%"
                    color="primary"
                  />
                  <MetricGauge
                    label="Memory"
                    value={
                      server.latestMetrics?.memoryTotalMb
                        ? ((server.latestMetrics.memoryUsedMb ?? 0) /
                            server.latestMetrics.memoryTotalMb) *
                          100
                        : undefined
                    }
                    displayValue={
                      server.latestMetrics?.memoryUsedMb != null && server.latestMetrics?.memoryTotalMb
                        ? `${(server.latestMetrics.memoryUsedMb / 1024).toFixed(1)}/${(server.latestMetrics.memoryTotalMb / 1024).toFixed(0)}GB`
                        : undefined
                    }
                    max={100}
                    unit="%"
                    color="green"
                  />
                  <MetricGauge
                    label="Disk"
                    value={
                      server.latestMetrics?.diskTotalGb
                        ? ((server.latestMetrics.diskUsedGb ?? 0) /
                            server.latestMetrics.diskTotalGb) *
                          100
                        : undefined
                    }
                    displayValue={
                      server.latestMetrics?.diskUsedGb != null && server.latestMetrics?.diskTotalGb
                        ? `${server.latestMetrics.diskUsedGb.toFixed(0)}/${server.latestMetrics.diskTotalGb.toFixed(0)}GB`
                        : undefined
                    }
                    max={100}
                    unit="%"
                    color="yellow"
                  />
                  <MetricGauge
                    label="Load"
                    value={server.latestMetrics?.loadAvg1 ?? undefined}
                    max={4}
                    displayValue={server.latestMetrics?.loadAvg1?.toFixed(2) ?? undefined}
                    color="purple"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {serversWithMetrics.length === 0 && (
        <div className="card text-center py-12 mb-8">
          <p className="text-slate-400 mb-2">No metrics available</p>
          <p className="text-slate-500 text-sm">
            Enable monitoring on your servers to see resource usage.
          </p>
          <Link to="/servers" className="btn btn-primary mt-4">
            Configure Servers
          </Link>
        </div>
      )}

      {/* Services Table */}
      {servicesWithMetrics.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-white mb-4">
            Service Resource Usage
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                  <th className="pb-3 font-medium">Service</th>
                  <th className="pb-3 font-medium">Server</th>
                  <th className="pb-3 font-medium">CPU</th>
                  <th className="pb-3 font-medium">Memory</th>
                  <th className="pb-3 font-medium">Network I/O</th>
                  <th className="pb-3 font-medium">Restarts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {servicesWithMetrics.map((service) => (
                  <tr key={service.id} className="text-slate-300">
                    <td className="py-3">
                      <Link
                        to={`/services/${service.id}`}
                        className="text-white hover:text-brand-400"
                      >
                        {service.name}
                      </Link>
                    </td>
                    <td className="py-3">
                      <Link
                        to={`/servers/${service.serverId}`}
                        className="hover:text-brand-400"
                      >
                        {service.serverName}
                      </Link>
                    </td>
                    <td className="py-3">
                      <span
                        className={
                          (service.metrics.cpuPercent || 0) > 80 ? 'text-red-400' : ''
                        }
                      >
                        {service.metrics.cpuPercent?.toFixed(1) ?? '-'}%
                      </span>
                    </td>
                    <td className="py-3">
                      {service.metrics.memoryUsedMb ? (
                        <span>
                          {service.metrics.memoryUsedMb.toFixed(0)}MB
                          {service.metrics.memoryLimitMb && (
                            <span className="text-slate-500">
                              {' '}
                              / {service.metrics.memoryLimitMb.toFixed(0)}MB
                            </span>
                          )}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="py-3 text-sm font-mono">
                      {service.metrics.networkRxMb || service.metrics.networkTxMb ? (
                        <span>
                          <span className="text-green-400">
                            {service.metrics.networkRxMb?.toFixed(1) ?? '0'}
                          </span>
                          /
                          <span className="text-blue-400">
                            {service.metrics.networkTxMb?.toFixed(1) ?? '0'}
                          </span>
                          MB
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="py-3">
                      {service.metrics.restartCount != null ? (
                        <span
                          className={service.metrics.restartCount > 0 ? 'text-yellow-400' : ''}
                        >
                          {service.metrics.restartCount}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string | number;
  color: 'blue' | 'green' | 'emerald' | 'red' | 'slate';
}

// Hoisted color maps outside component to avoid recreation on each render
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

// Memoized to prevent re-renders when parent updates
const StatCard = memo(function StatCard({ label, value, color }: StatCardProps) {
  return (
    <div className={`rounded-xl border p-4 ${STAT_COLOR_CLASSES[color]}`}>
      <p className="text-slate-400 text-xs mb-1">{label}</p>
      <p className={`text-2xl font-bold ${STAT_TEXT_COLORS[color]}`}>{value}</p>
    </div>
  );
});

interface ChartCardProps {
  title: string;
  data: Record<string, unknown>[];
  serverNames: string[];
  formatTime: (time: string) => string;
  unit?: string;
  domain?: [number | 'auto', number | 'auto'];
}

// Memoized to prevent expensive Recharts re-renders during auto-refresh
const ChartCard = memo(function ChartCard({ title, data, serverNames, formatTime, unit, domain }: ChartCardProps) {
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
          {serverNames.map((name, i) => (
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

interface MetricGaugeProps {
  label: string;
  value?: number;
  displayValue?: string;
  max: number;
  unit?: string;
  color: 'primary' | 'green' | 'yellow' | 'purple';
}

// Hoisted color maps outside component
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

// Memoized to prevent re-renders when parent updates
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

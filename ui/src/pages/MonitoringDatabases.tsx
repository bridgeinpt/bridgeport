import { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getDatabaseMonitoringSummary,
  getDatabaseMetricsHistory,
  type DatabaseMonitoringSummaryItem,
  type DatabaseMetricsHistoryItem,
  type DatabaseQueryMeta,
} from '../lib/api';
import { format, formatDistanceToNow } from 'date-fns';
import ChartCard from '../components/monitoring/ChartCard';
import TimeRangeSelector from '../components/monitoring/TimeRangeSelector';
import AutoRefreshToggle from '../components/monitoring/AutoRefreshToggle';
import { DatabaseIcon } from '../components/Icons';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatMetricValue(value: unknown, unit?: string): string {
  if (value == null) return '-';
  const num = Number(value);
  if (isNaN(num)) return String(value);
  if (unit === 'bytes') return formatBytes(num);
  if (unit === '%') return `${num.toFixed(1)}%`;
  if (Number.isInteger(num)) return num.toLocaleString();
  return num.toFixed(2);
}

function StatusDot({ status, enabled }: { status: string; enabled: boolean }) {
  if (!enabled) return <span className="w-2 h-2 rounded-full bg-slate-600" title="Monitoring disabled" />;
  const colors: Record<string, string> = {
    connected: 'bg-green-400',
    error: 'bg-red-400',
    unknown: 'bg-slate-500',
  };
  return <span className={`w-2 h-2 rounded-full ${colors[status] || colors.unknown}`} title={status} />;
}

export default function MonitoringDatabases() {
  const {
    selectedEnvironment,
    monitoringTimeRange,
    setMonitoringTimeRange,
    autoRefreshEnabled,
    setAutoRefreshEnabled,
    monitoringDatabaseFilter,
    setMonitoringDatabaseFilter,
  } = useAppStore();

  const [summary, setSummary] = useState<DatabaseMonitoringSummaryItem[]>([]);
  const [metricsHistory, setMetricsHistory] = useState<DatabaseMetricsHistoryItem[]>([]);
  const [queryMeta, setQueryMeta] = useState<DatabaseQueryMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async (isRefresh = false) => {
    if (!selectedEnvironment?.id) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const [summaryRes, historyRes] = await Promise.all([
        getDatabaseMonitoringSummary(selectedEnvironment.id),
        getDatabaseMetricsHistory(selectedEnvironment.id, monitoringTimeRange),
      ]);
      setSummary(summaryRes.databases);
      setMetricsHistory(historyRes.databases);
      setQueryMeta(historyRes.queryMeta);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [selectedEnvironment?.id, monitoringTimeRange]);

  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const interval = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(interval);
  }, [selectedEnvironment?.id, monitoringTimeRange, autoRefreshEnabled]);

  // All databases for the filter
  const allDatabases = useMemo(() => {
    return summary
      .map((db) => ({ id: db.id, name: db.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [summary]);

  // Filter by database ID
  const filterSet = useMemo(() => new Set(monitoringDatabaseFilter), [monitoringDatabaseFilter]);

  const filteredMetricsHistory = useMemo(() => {
    if (filterSet.size === 0) return metricsHistory;
    return metricsHistory.filter((db) => filterSet.has(db.id));
  }, [metricsHistory, filterSet]);

  const filteredSummary = useMemo(() => {
    if (filterSet.size === 0) return summary;
    return summary.filter((db) => filterSet.has(db.id));
  }, [summary, filterSet]);

  const handleFilterToggle = useCallback(
    (id: string) => {
      const newFilter = monitoringDatabaseFilter.includes(id)
        ? monitoringDatabaseFilter.filter((i) => i !== id)
        : [...monitoringDatabaseFilter, id];
      setMonitoringDatabaseFilter(newFilter);
    },
    [monitoringDatabaseFilter, setMonitoringDatabaseFilter]
  );

  // Prepare chart data for a given query metric
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prepareChartData = (meta: DatabaseQueryMeta): { data: any[]; names: string[] } => {
    const timeMap = new Map<string, Record<string, unknown>>();
    const nameSet = new Set<string>();

    if (meta.resultType === 'scalar') {
      // Scalar: one line per database
      filteredMetricsHistory.forEach((db) => {
        db.data.forEach((point) => {
          const time = point.time as string;
          if (!timeMap.has(time)) timeMap.set(time, { time });
          const entry = timeMap.get(time)!;
          const val = point[meta.name];
          if (val != null) {
            entry[db.name] = val;
            nameSet.add(db.name);
          }
        });
      });
    } else if (meta.resultType === 'row') {
      // Row: flatten to dbName.fieldName — but only if ≤ 3 databases have this query
      const dbsWithQuery = filteredMetricsHistory.filter((db) =>
        db.data.some((point) => {
          // Check for flattened row keys like "connections.active"
          return Object.keys(point).some((k) => k.startsWith(`${meta.name}.`));
        })
      );

      if (dbsWithQuery.length <= 3) {
        dbsWithQuery.forEach((db) => {
          db.data.forEach((point) => {
            const time = point.time as string;
            if (!timeMap.has(time)) timeMap.set(time, { time });
            const entry = timeMap.get(time)!;

            for (const [key, value] of Object.entries(point)) {
              if (key.startsWith(`${meta.name}.`) && value != null) {
                const field = key.slice(meta.name.length + 1);
                const lineName = dbsWithQuery.length === 1 ? field : `${db.name}.${field}`;
                entry[lineName] = value;
                nameSet.add(lineName);
              }
            }
          });
        });
      } else {
        // Too many databases — skip row query charting
        return { data: [], names: [] };
      }
    }

    const data = Array.from(timeMap.values()).sort((a, b) =>
      (a.time as string).localeCompare(b.time as string)
    );
    return { data, names: Array.from(nameSet) };
  };

  const formatTime = (time: string) => {
    const date = new Date(time);
    if (monitoringTimeRange <= 24) return format(date, 'HH:mm');
    return format(date, 'MMM d HH:mm');
  };

  const getChartUnit = (meta: DatabaseQueryMeta): string => {
    if (meta.unit === 'bytes') return ' MB';
    if (meta.unit === '%') return '%';
    return '';
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getChartDomain = (meta: DatabaseQueryMeta): [number | 'auto', number | 'auto'] => {
    if (meta.unit === '%') return [0, 100];
    return [0, 'auto'];
  };

  // For byte-unit charts, convert values from bytes to MB for readability
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transformBytesToMB = (data: any[], names: string[]): any[] => {
    return data.map((point) => {
      const newPoint = { ...point };
      for (const name of names) {
        if (newPoint[name] != null) {
          newPoint[name] = Number(newPoint[name]) / (1024 * 1024);
        }
      }
      return newPoint;
    });
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <p className="text-slate-400">Select an environment to view database monitoring</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-6 w-64 bg-slate-700 rounded mb-6"></div>
          <div className="grid grid-cols-2 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-64 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const monitoredCount = filteredSummary.filter((db) => db.monitoringEnabled).length;
  const connectedCount = filteredSummary.filter((db) => db.monitoringStatus === 'connected').length;
  const errorCount = filteredSummary.filter((db) => db.monitoringStatus === 'error').length;

  const hasChartData = filteredMetricsHistory.length > 0 && filteredMetricsHistory.some((db) => db.data.length > 0);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Database monitoring across {selectedEnvironment.name}
        </p>
        <AutoRefreshToggle
          enabled={autoRefreshEnabled}
          onChange={setAutoRefreshEnabled}
          onRefresh={() => fetchData(true)}
          refreshing={refreshing}
        />
      </div>

      {/* Time Range and Tag Filter */}
      <div className="flex items-center flex-wrap gap-4 mb-6">
        <TimeRangeSelector
          value={monitoringTimeRange}
          onChange={setMonitoringTimeRange}
        />

        {allDatabases.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Databases:</span>
            <div className="flex flex-wrap gap-1">
              {allDatabases.map((db) => (
                <button
                  key={db.id}
                  onClick={() => handleFilterToggle(db.id)}
                  className={`px-2 py-1 text-xs rounded-full transition-colors ${
                    filterSet.has(db.id)
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {db.name}
                </button>
              ))}
              {filterSet.size > 0 && (
                <button
                  onClick={() => setMonitoringDatabaseFilter([])}
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
      {hasChartData ? (
        <>
          <div className="grid grid-cols-2 gap-6 mb-8">
            {queryMeta.map((meta) => {
              const { data, names } = prepareChartData(meta);
              if (data.length === 0 || names.length === 0) return null;

              const chartUnit = getChartUnit(meta);
              const chartDomain = getChartDomain(meta);
              const chartData = meta.unit === 'bytes' ? transformBytesToMB(data, names) : data;

              return (
                <ChartCard
                  key={meta.name}
                  title={meta.displayName}
                  data={chartData}
                  names={names}
                  formatTime={formatTime}
                  unit={chartUnit}
                  domain={chartDomain}
                />
              );
            })}
          </div>

          {/* Database Table */}
          {filteredSummary.length > 0 && (
            <div className="card">
              <h2 className="text-lg font-semibold text-white mb-4">
                Database Status
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                      <th className="pb-3 font-medium">Database</th>
                      <th className="pb-3 font-medium">Server</th>
                      <th className="pb-3 font-medium">Type</th>
                      <th className="pb-3 font-medium">Status</th>
                      {queryMeta.filter((m) => m.resultType === 'scalar').slice(0, 4).map((m) => (
                        <th key={m.name} className="pb-3 font-medium">{m.displayName}</th>
                      ))}
                      <th className="pb-3 font-medium">Last Collected</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {filteredSummary.map((db) => (
                      <tr key={db.id} className="text-slate-300">
                        <td className="py-3">
                          <Link
                            to={`/monitoring/databases/${db.id}`}
                            className="text-white hover:text-brand-400 font-medium"
                          >
                            {db.name}
                          </Link>
                        </td>
                        <td className="py-3 text-sm">{db.serverName || '-'}</td>
                        <td className="py-3">
                          <span className="badge bg-slate-700 text-slate-300 text-xs">
                            {db.databaseType?.displayName || db.type}
                          </span>
                        </td>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <StatusDot status={db.monitoringStatus} enabled={db.monitoringEnabled} />
                            <span className="text-sm">
                              {!db.monitoringEnabled ? 'Disabled' : db.monitoringStatus}
                            </span>
                          </div>
                        </td>
                        {queryMeta.filter((m) => m.resultType === 'scalar').slice(0, 4).map((m) => (
                          <td key={m.name} className="py-3 text-sm font-mono">
                            {db.latestMetrics?.[m.name] != null
                              ? formatMetricValue(db.latestMetrics[m.name], m.unit)
                              : '-'}
                          </td>
                        ))}
                        <td className="py-3 text-sm text-slate-500">
                          {db.lastCollectedAt
                            ? formatDistanceToNow(new Date(db.lastCollectedAt), { addSuffix: true })
                            : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : filteredSummary.length > 0 ? (
        <>
          {/* Summary Stats when no chart data */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="rounded-xl border p-4 bg-blue-500/10 border-blue-500/30">
              <p className="text-slate-400 text-xs mb-1">Total</p>
              <p className="text-2xl font-bold text-blue-400">{filteredSummary.length}</p>
            </div>
            <div className="rounded-xl border p-4 bg-green-500/10 border-green-500/30">
              <p className="text-slate-400 text-xs mb-1">Monitored</p>
              <p className="text-2xl font-bold text-green-400">{monitoredCount}</p>
            </div>
            <div className="rounded-xl border p-4 bg-emerald-500/10 border-emerald-500/30">
              <p className="text-slate-400 text-xs mb-1">Connected</p>
              <p className="text-2xl font-bold text-emerald-400">{connectedCount}</p>
            </div>
            <div className={`rounded-xl border p-4 ${errorCount > 0 ? 'bg-red-500/10 border-red-500/30' : 'bg-slate-500/10 border-slate-500/30'}`}>
              <p className="text-slate-400 text-xs mb-1">Errors</p>
              <p className={`text-2xl font-bold ${errorCount > 0 ? 'text-red-400' : 'text-slate-400'}`}>{errorCount}</p>
            </div>
          </div>

          <div className="card text-center py-12">
            <p className="text-slate-400 mb-2">No metrics data collected yet</p>
            <p className="text-slate-500 text-sm">
              Enable monitoring on your databases to start collecting metrics.
            </p>
            <Link to="/databases" className="btn btn-primary mt-4">
              Configure Databases
            </Link>
          </div>
        </>
      ) : (
        <div className="card text-center py-12">
          <DatabaseIcon className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400 mb-2">No databases configured</p>
          <p className="text-slate-500 text-sm">
            Add databases in your environment to monitor their performance and health.
          </p>
          <Link to="/databases" className="btn btn-primary mt-4">
            Configure Databases
          </Link>
        </div>
      )}
    </div>
  );
}

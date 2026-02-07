import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { api } from '../lib/api';
import { format, formatDistanceToNow } from 'date-fns';
import ChartCard from '../components/monitoring/ChartCard';
import TimeRangeSelector from '../components/monitoring/TimeRangeSelector';
import AutoRefreshToggle from '../components/monitoring/AutoRefreshToggle';

interface MetricsEntry {
  collectedAt: string;
  data: Record<string, unknown>;
}

interface MonitoringQuery {
  name: string;
  displayName: string;
  resultType: 'scalar' | 'row' | 'rows';
  unit?: string;
  chartGroup?: string;
}

interface MonitoringConfig {
  connectionMode: string;
  driver?: string;
  queries: MonitoringQuery[];
}

interface DatabaseInfo {
  id: string;
  name: string;
  type: string;
  environmentId: string;
  monitoringStatus: string;
  lastCollectedAt: string | null;
  databaseType?: { displayName: string };
  server?: { name: string };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function prepareScalarChartData(
  metrics: MetricsEntry[],
  queryName: string
): Array<{ time: string; value: number | null }> {
  return metrics.map((m) => ({
    time: m.collectedAt,
    value:
      typeof m.data[queryName] === 'number'
        ? (m.data[queryName] as number)
        : null,
  }));
}

function prepareRowChartData(
  metrics: MetricsEntry[],
  queryName: string
): Array<Record<string, unknown>> {
  return metrics.map((m) => {
    const val = m.data[queryName];
    if (val && typeof val === 'object' && !('error' in val)) {
      return { time: m.collectedAt, ...(val as Record<string, unknown>) };
    }
    return { time: m.collectedAt };
  });
}

function getRowFieldNames(
  metrics: MetricsEntry[],
  queryName: string
): string[] {
  const fields = new Set<string>();
  for (const m of metrics) {
    const val = m.data[queryName];
    if (val && typeof val === 'object' && !('error' in val)) {
      for (const key of Object.keys(val as Record<string, unknown>)) {
        if (key !== 'time') {
          fields.add(key);
        }
      }
    }
  }
  return Array.from(fields);
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'connected':
      return 'bg-green-500/20 text-green-400';
    case 'error':
      return 'bg-red-500/20 text-red-400';
    default:
      return 'bg-slate-500/20 text-slate-400';
  }
}

function getTypeColor(type: string): string {
  switch (type) {
    case 'postgres':
      return 'bg-blue-500/20 text-blue-400';
    case 'mysql':
      return 'bg-orange-500/20 text-orange-400';
    case 'sqlite':
      return 'bg-emerald-500/20 text-emerald-400';
    default:
      return 'bg-slate-500/20 text-slate-400';
  }
}

export default function DatabaseMonitoringDetail() {
  const { id } = useParams<{ id: string }>();
  const {
    selectedEnvironment,
    monitoringTimeRange,
    setMonitoringTimeRange,
    autoRefreshEnabled,
    setAutoRefreshEnabled,
    setBreadcrumbName,
  } = useAppStore();

  const [database, setDatabase] = useState<DatabaseInfo | null>(null);
  const [metrics, setMetrics] = useState<MetricsEntry[]>([]);
  const [monitoringConfig, setMonitoringConfig] =
    useState<MonitoringConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const envId = selectedEnvironment?.id || database?.environmentId;

  const fetchDatabase = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api.get<{ database: DatabaseInfo }>(
        `/databases/${id}`
      );
      setDatabase(res.database);
      if (id) setBreadcrumbName(id, res.database.name);
      return res.database;
    } catch {
      // Ignore - will show not found state
    }
  }, [id]);

  const fetchMetrics = useCallback(
    async (currentEnvId?: string) => {
      const resolvedEnvId = currentEnvId || envId;
      if (!id || !resolvedEnvId) return;
      try {
        const res = await api.get<{
          metrics: MetricsEntry[];
          monitoringConfig: MonitoringConfig;
        }>(
          `/environments/${resolvedEnvId}/databases/${id}/metrics?hours=${monitoringTimeRange}`
        );
        setMetrics(res.metrics);
        setMonitoringConfig(res.monitoringConfig);
      } catch {
        // Ignore - will show empty state
      }
    },
    [id, envId, monitoringTimeRange]
  );

  const fetchAll = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      try {
        const db = await fetchDatabase();
        const resolvedEnvId = db?.environmentId || envId;
        await fetchMetrics(resolvedEnvId);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [fetchDatabase, fetchMetrics, envId]
  );

  useEffect(() => {
    fetchAll();
  }, [id, monitoringTimeRange]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!autoRefreshEnabled || !id) return;
    const interval = setInterval(() => fetchAll(true), 30000);
    return () => clearInterval(interval);
  }, [autoRefreshEnabled, id, fetchAll]);

  const formatTime = useCallback(
    (time: string) => {
      const date = new Date(time);
      if (monitoringTimeRange <= 6) {
        return format(date, 'HH:mm');
      } else if (monitoringTimeRange <= 24) {
        return format(date, 'HH:mm');
      } else {
        return format(date, 'MMM d HH:mm');
      }
    },
    [monitoringTimeRange]
  );

  // Group queries by chartGroup
  const queryGroups = useMemo(() => {
    if (!monitoringConfig) return new Map<string, MonitoringQuery[]>();
    const groups = new Map<string, MonitoringQuery[]>();
    for (const query of monitoringConfig.queries) {
      const group = query.chartGroup || 'General';
      if (!groups.has(group)) {
        groups.set(group, []);
      }
      groups.get(group)!.push(query);
    }
    return groups;
  }, [monitoringConfig]);

  // Format value for table display
  const formatTableValue = (value: unknown, unit?: string): string => {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'number') {
      if (unit === 'bytes' || unit === 'B') return formatBytes(value);
      if (unit === '%') return `${value.toFixed(1)}%`;
      if (Number.isInteger(value)) return value.toLocaleString();
      return value.toFixed(2);
    }
    return String(value);
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-64 bg-slate-700 rounded" />
          <div className="h-12 bg-slate-700 rounded" />
          <div className="grid grid-cols-2 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-64 bg-slate-800 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!database) {
    return (
      <div className="p-6">
        <p className="text-slate-400">Database not found</p>
        <Link
          to="/monitoring/databases"
          className="text-brand-400 hover:text-brand-300 mt-2 inline-block"
        >
          Back to Databases
        </Link>
      </div>
    );
  }

  const typeName =
    database.databaseType?.displayName || database.type;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link
            to="/monitoring/databases"
            className="text-slate-400 hover:text-white"
          >
            &larr; Back
          </Link>
          <span className="text-xl font-bold text-white">{database.name}</span>
          <span
            className={`px-2 py-0.5 text-xs rounded-full ${getTypeColor(database.type)}`}
          >
            {typeName}
          </span>
          <span
            className={`px-2 py-0.5 text-xs rounded-full ${getStatusColor(database.monitoringStatus)}`}
          >
            {database.monitoringStatus}
          </span>
          {database.server && (
            <span className="text-sm text-slate-500">
              on {database.server.name}
            </span>
          )}
        </div>
        <div className="text-sm text-slate-500">
          {database.lastCollectedAt
            ? `Last collected ${formatDistanceToNow(new Date(database.lastCollectedAt), { addSuffix: true })}`
            : 'Never collected'}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between mb-6">
        <TimeRangeSelector
          value={monitoringTimeRange}
          onChange={setMonitoringTimeRange}
        />
        <AutoRefreshToggle
          enabled={autoRefreshEnabled}
          onChange={setAutoRefreshEnabled}
          onRefresh={() => fetchAll(true)}
          refreshing={refreshing}
        />
      </div>

      {/* Content */}
      {!monitoringConfig || monitoringConfig.queries.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-slate-400 mb-2">No monitoring configuration available</p>
          <p className="text-slate-500 text-sm">
            Monitoring queries have not been configured for this database type.
          </p>
        </div>
      ) : metrics.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-slate-400 mb-2">No metrics collected yet</p>
          <p className="text-slate-500 text-sm">
            Metrics will appear here as they are collected.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {Array.from(queryGroups.entries()).map(([groupName, queries]) => {
            const scalarQueries = queries.filter(
              (q) => q.resultType === 'scalar'
            );
            const rowQueries = queries.filter((q) => q.resultType === 'row');
            const rowsQueries = queries.filter((q) => q.resultType === 'rows');

            return (
              <div key={groupName}>
                <h2 className="text-lg font-semibold text-white mb-4">
                  {groupName}
                </h2>

                {/* Scalar charts */}
                {scalarQueries.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    {scalarQueries.map((query) => {
                      const data = prepareScalarChartData(
                        metrics,
                        query.name
                      );
                      const domain: [number | 'auto', number | 'auto'] =
                        query.unit === '%' ? [0, 100] : [0, 'auto'];
                      return (
                        <ChartCard
                          key={query.name}
                          title={query.displayName}
                          data={data}
                          names={['value']}
                          formatTime={formatTime}
                          unit={query.unit}
                          domain={domain}
                        />
                      );
                    })}
                  </div>
                )}

                {/* Row charts (multiple lines per field) */}
                {rowQueries.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    {rowQueries.map((query) => {
                      const data = prepareRowChartData(metrics, query.name);
                      const fieldNames = getRowFieldNames(metrics, query.name);
                      if (fieldNames.length === 0) return null;
                      const domain: [number | 'auto', number | 'auto'] =
                        query.unit === '%' ? [0, 100] : [0, 'auto'];
                      return (
                        <ChartCard
                          key={query.name}
                          title={query.displayName}
                          data={data}
                          names={fieldNames}
                          formatTime={formatTime}
                          unit={query.unit}
                          domain={domain}
                        />
                      );
                    })}
                  </div>
                )}

                {/* Rows queries (tables showing latest snapshot) */}
                {rowsQueries.map((query) => {
                  const latestEntry = metrics[metrics.length - 1];
                  const rawValue = latestEntry?.data[query.name];
                  if (
                    !rawValue ||
                    !Array.isArray(rawValue) ||
                    rawValue.length === 0
                  ) {
                    return (
                      <div key={query.name} className="card mb-6">
                        <h3 className="text-sm font-medium text-white mb-4">
                          {query.displayName}
                        </h3>
                        <div className="h-24 flex items-center justify-center text-slate-500">
                          No data available
                        </div>
                      </div>
                    );
                  }

                  const rows = rawValue as Array<Record<string, unknown>>;
                  const columns = Object.keys(rows[0]);

                  return (
                    <div key={query.name} className="card mb-6">
                      <h3 className="text-sm font-medium text-white mb-4">
                        {query.displayName}
                      </h3>
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead>
                            <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                              {columns.map((col) => (
                                <th key={col} className="pb-3 pr-4 font-medium">
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-700">
                            {rows.map((row, rowIndex) => (
                              <tr key={rowIndex} className="text-slate-300">
                                {columns.map((col) => (
                                  <td
                                    key={col}
                                    className="py-3 pr-4 text-sm font-mono"
                                  >
                                    {formatTableValue(row[col], query.unit)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getDatabaseMonitoringSummary,
  getDatabaseMetricsHistory,
  type DatabaseMonitoringSummaryItem,
  type DatabaseMetricsTypeGroup,
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

function formatTableValue(value: unknown, unit?: string): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number') {
    if (unit === 'bytes' || unit === 'B') return formatBytes(value);
    if (unit === '%') return `${value.toFixed(1)}%`;
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(2);
  }
  return String(value);
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

function getTypeColor(type: string): string {
  switch (type) {
    case 'postgres': return 'bg-blue-500/20 text-blue-400';
    case 'mysql': return 'bg-orange-500/20 text-orange-400';
    case 'sqlite': return 'bg-emerald-500/20 text-emerald-400';
    case 'redis': return 'bg-red-500/20 text-red-400';
    default: return 'bg-slate-500/20 text-slate-400';
  }
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
    monitoringDatabaseTypeTab,
    setMonitoringDatabaseTypeTab,
  } = useAppStore();

  const [summary, setSummary] = useState<DatabaseMonitoringSummaryItem[]>([]);
  const [typeGroups, setTypeGroups] = useState<DatabaseMetricsTypeGroup[]>([]);
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
      setTypeGroups(historyRes.types);
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

  // Resolve active tab
  const activeType = useMemo(() => {
    if (typeGroups.length === 0) return '';
    if (monitoringDatabaseTypeTab && typeGroups.some((g) => g.type === monitoringDatabaseTypeTab)) {
      return monitoringDatabaseTypeTab;
    }
    return typeGroups[0].type;
  }, [typeGroups, monitoringDatabaseTypeTab]);

  const activeGroup = useMemo(() => {
    return typeGroups.find((g) => g.type === activeType) || null;
  }, [typeGroups, activeType]);

  // Summary databases scoped to active type
  const typeSummary = useMemo(() => {
    if (!activeType) return summary;
    return summary.filter((db) => db.type === activeType);
  }, [summary, activeType]);

  // Database filter scoped to active type
  const allDatabasesForType = useMemo(() => {
    return typeSummary
      .map((db) => ({ id: db.id, name: db.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [typeSummary]);

  const filterSet = useMemo(() => new Set(monitoringDatabaseFilter), [monitoringDatabaseFilter]);

  const filteredDatabases = useMemo(() => {
    if (!activeGroup) return [];
    if (filterSet.size === 0) return activeGroup.databases;
    return activeGroup.databases.filter((db) => filterSet.has(db.id));
  }, [activeGroup, filterSet]);

  const filteredSummary = useMemo(() => {
    if (filterSet.size === 0) return typeSummary;
    return typeSummary.filter((db) => filterSet.has(db.id));
  }, [typeSummary, filterSet]);

  const handleFilterToggle = useCallback(
    (id: string) => {
      const newFilter = monitoringDatabaseFilter.includes(id)
        ? monitoringDatabaseFilter.filter((i) => i !== id)
        : [...monitoringDatabaseFilter, id];
      setMonitoringDatabaseFilter(newFilter);
    },
    [monitoringDatabaseFilter, setMonitoringDatabaseFilter]
  );

  // Clear filter when switching types
  const handleTypeChange = useCallback(
    (type: string) => {
      setMonitoringDatabaseTypeTab(type);
      setMonitoringDatabaseFilter([]);
    },
    [setMonitoringDatabaseTypeTab, setMonitoringDatabaseFilter]
  );

  // Chart data preparation for scalar queries (one line per database)
  const prepareScalarChartData = (
    queryName: string,
    databases: typeof filteredDatabases
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): { data: any[]; names: string[] } => {
    const timeMap = new Map<string, Record<string, unknown>>();
    const nameSet = new Set<string>();

    databases.forEach((db) => {
      db.data.forEach((point) => {
        const time = point.time as string;
        if (!timeMap.has(time)) timeMap.set(time, { time });
        const entry = timeMap.get(time)!;
        const val = point[queryName];
        if (val != null) {
          entry[db.name] = val;
          nameSet.add(db.name);
        }
      });
    });

    const data = Array.from(timeMap.values()).sort((a, b) =>
      (a.time as string).localeCompare(b.time as string)
    );
    return { data, names: Array.from(nameSet) };
  };

  // Chart data preparation for row queries (multiple fields per database)
  const prepareRowChartData = (
    queryName: string,
    databases: typeof filteredDatabases
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): { data: any[]; names: string[] } => {
    const timeMap = new Map<string, Record<string, unknown>>();
    const nameSet = new Set<string>();

    const dbsWithQuery = databases.filter((db) =>
      db.data.some((point) => Object.keys(point).some((k) => k.startsWith(`${queryName}.`)))
    );

    if (dbsWithQuery.length === 0) return { data: [], names: [] };

    dbsWithQuery.forEach((db) => {
      db.data.forEach((point) => {
        const time = point.time as string;
        if (!timeMap.has(time)) timeMap.set(time, { time });
        const entry = timeMap.get(time)!;

        for (const [key, value] of Object.entries(point)) {
          if (key.startsWith(`${queryName}.`) && value != null) {
            const field = key.slice(queryName.length + 1);
            const lineName = dbsWithQuery.length === 1 ? field : `${db.name}.${field}`;
            entry[lineName] = value;
            nameSet.add(lineName);
          }
        }
      });
    });

    const data = Array.from(timeMap.values()).sort((a, b) =>
      (a.time as string).localeCompare(b.time as string)
    );
    return { data, names: Array.from(nameSet) };
  };

  // Get latest "rows" snapshot across filtered databases
  const getRowsSnapshot = (queryName: string): Array<Record<string, unknown>> | null => {
    for (const db of filteredDatabases) {
      if (db.data.length === 0) continue;
      const latest = db.data[db.data.length - 1];
      const val = latest[queryName];
      if (Array.isArray(val) && val.length > 0) return val as Array<Record<string, unknown>>;
    }
    return null;
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

  const getChartDomain = (meta: DatabaseQueryMeta): [number | 'auto', number | 'auto'] => {
    if (meta.unit === '%') return [0, 100];
    return [0, 'auto'];
  };

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

  // No databases at all
  if (summary.length === 0) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-5">
          <p className="text-slate-400">Database monitoring across {selectedEnvironment.name}</p>
        </div>
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
      </div>
    );
  }

  // Group query metadata by chartGroup
  const queryGroups = new Map<string, DatabaseQueryMeta[]>();
  if (activeGroup) {
    for (const meta of activeGroup.queryMeta) {
      const group = meta.chartGroup || 'General';
      if (!queryGroups.has(group)) queryGroups.set(group, []);
      queryGroups.get(group)!.push(meta);
    }
  }

  const hasChartData = filteredDatabases.length > 0 && filteredDatabases.some((db) => db.data.length > 0);

  const scalarMetaForTable = activeGroup
    ? activeGroup.queryMeta.filter((m) => m.resultType === 'scalar').slice(0, 4)
    : [];

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

      {/* Type Tabs */}
      {typeGroups.length > 1 && (
        <div className="flex border-b border-slate-700 mb-6">
          {typeGroups.map((group) => (
            <button
              key={group.type}
              onClick={() => handleTypeChange(group.type)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
                activeType === group.type
                  ? 'border-brand-600 text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className={`inline-block w-2 h-2 rounded-full mr-2 ${getTypeColor(group.type).split(' ')[0]}`} />
              {group.typeName}
              <span className="ml-1.5 text-xs text-slate-500">({group.databases.length})</span>
            </button>
          ))}
        </div>
      )}

      {/* Controls: Time Range + Database Filter */}
      <div className="flex items-center flex-wrap gap-4 mb-6">
        <TimeRangeSelector
          value={monitoringTimeRange}
          onChange={setMonitoringTimeRange}
        />

        {allDatabasesForType.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Databases:</span>
            <div className="flex flex-wrap gap-1">
              {allDatabasesForType.map((db) => (
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

      {/* Charts grouped by chartGroup */}
      {hasChartData ? (
        <>
          <div className="space-y-8 mb-8">
            {Array.from(queryGroups.entries()).map(([groupName, queries]) => {
              const scalarQueries = queries.filter((q) => q.resultType === 'scalar');
              const rowQueries = queries.filter((q) => q.resultType === 'row');
              const rowsQueries = queries.filter((q) => q.resultType === 'rows');

              const hasContent =
                scalarQueries.length > 0 || rowQueries.length > 0 || rowsQueries.length > 0;
              if (!hasContent) return null;

              return (
                <div key={groupName}>
                  <h2 className="text-lg font-semibold text-white mb-4">{groupName}</h2>

                  {/* Scalar charts */}
                  {scalarQueries.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                      {scalarQueries.map((meta) => {
                        const { data, names } = prepareScalarChartData(meta.name, filteredDatabases);
                        if (data.length === 0 || names.length === 0) return null;
                        const chartData = meta.unit === 'bytes' ? transformBytesToMB(data, names) : data;
                        return (
                          <ChartCard
                            key={meta.name}
                            title={meta.displayName}
                            data={chartData}
                            names={names}
                            formatTime={formatTime}
                            unit={getChartUnit(meta)}
                            domain={getChartDomain(meta)}
                          />
                        );
                      })}
                    </div>
                  )}

                  {/* Row charts (multiple field lines) */}
                  {rowQueries.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                      {rowQueries.map((meta) => {
                        const { data, names } = prepareRowChartData(meta.name, filteredDatabases);
                        if (data.length === 0 || names.length === 0) return null;
                        const chartData = meta.unit === 'bytes' ? transformBytesToMB(data, names) : data;
                        return (
                          <ChartCard
                            key={meta.name}
                            title={meta.displayName}
                            data={chartData}
                            names={names}
                            formatTime={formatTime}
                            unit={getChartUnit(meta)}
                            domain={getChartDomain(meta)}
                          />
                        );
                      })}
                    </div>
                  )}

                  {/* Rows queries (latest snapshot tables) */}
                  {rowsQueries.map((meta) => {
                    const rows = getRowsSnapshot(meta.name);
                    if (!rows || rows.length === 0) {
                      return (
                        <div key={meta.name} className="card mb-6">
                          <h3 className="text-sm font-medium text-white mb-4">{meta.displayName}</h3>
                          <div className="h-24 flex items-center justify-center text-slate-500">
                            No data available
                          </div>
                        </div>
                      );
                    }
                    const columns = Object.keys(rows[0]);
                    return (
                      <div key={meta.name} className="card mb-6">
                        <h3 className="text-sm font-medium text-white mb-4">{meta.displayName}</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full">
                            <thead>
                              <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                                {columns.map((col) => (
                                  <th key={col} className="pb-3 pr-4 font-medium">{col}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-700">
                              {rows.map((row, rowIndex) => (
                                <tr key={rowIndex} className="text-slate-300">
                                  {columns.map((col) => (
                                    <td key={col} className="py-3 pr-4 text-sm font-mono">
                                      {formatTableValue(row[col], meta.unit)}
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

          {/* Database Status Table */}
          {filteredSummary.length > 0 && (
            <div className="card">
              <h2 className="text-lg font-semibold text-white mb-4">Database Status</h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                      <th className="pb-3 font-medium">Database</th>
                      <th className="pb-3 font-medium">Server</th>
                      <th className="pb-3 font-medium">Status</th>
                      {scalarMetaForTable.map((m) => (
                        <th key={m.name} className="pb-3 font-medium">{m.displayName}</th>
                      ))}
                      <th className="pb-3 font-medium">Last Collected</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {filteredSummary.map((db) => (
                      <tr key={db.id} className="text-slate-300">
                        <td className="py-3">
                          <span className="text-white font-medium">{db.name}</span>
                        </td>
                        <td className="py-3 text-sm">{db.serverName || '-'}</td>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <StatusDot status={db.monitoringStatus} enabled={db.monitoringEnabled} />
                            <span className="text-sm">
                              {!db.monitoringEnabled ? 'Disabled' : db.monitoringStatus}
                            </span>
                          </div>
                        </td>
                        {scalarMetaForTable.map((m) => (
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
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="rounded-xl border p-4 bg-blue-500/10 border-blue-500/30">
              <p className="text-slate-400 text-xs mb-1">Total</p>
              <p className="text-2xl font-bold text-blue-400">{filteredSummary.length}</p>
            </div>
            <div className="rounded-xl border p-4 bg-green-500/10 border-green-500/30">
              <p className="text-slate-400 text-xs mb-1">Monitored</p>
              <p className="text-2xl font-bold text-green-400">
                {filteredSummary.filter((db) => db.monitoringEnabled).length}
              </p>
            </div>
            <div className="rounded-xl border p-4 bg-emerald-500/10 border-emerald-500/30">
              <p className="text-slate-400 text-xs mb-1">Connected</p>
              <p className="text-2xl font-bold text-emerald-400">
                {filteredSummary.filter((db) => db.monitoringStatus === 'connected').length}
              </p>
            </div>
            {(() => {
              const errorCount = filteredSummary.filter((db) => db.monitoringStatus === 'error').length;
              return (
                <div className={`rounded-xl border p-4 ${errorCount > 0 ? 'bg-red-500/10 border-red-500/30' : 'bg-slate-500/10 border-slate-500/30'}`}>
                  <p className="text-slate-400 text-xs mb-1">Errors</p>
                  <p className={`text-2xl font-bold ${errorCount > 0 ? 'text-red-400' : 'text-slate-400'}`}>{errorCount}</p>
                </div>
              );
            })()}
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
          <p className="text-slate-400 mb-2">No monitored databases of this type</p>
          <p className="text-slate-500 text-sm">
            Enable monitoring on your databases to see metrics here.
          </p>
        </div>
      )}
    </div>
  );
}

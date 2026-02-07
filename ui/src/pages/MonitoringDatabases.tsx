import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getDatabaseMonitoringSummary,
  getDatabaseMetricsHistory,
  type DatabaseMonitoringSummaryItem,
  type DatabaseMetricsTypeGroup,
  type DatabaseQueryMeta,
} from '../lib/api';
import { format } from 'date-fns';
import ChartCard from '../components/monitoring/ChartCard';
import TimeRangeSelector from '../components/monitoring/TimeRangeSelector';
import AutoRefreshToggle from '../components/monitoring/AutoRefreshToggle';
import EmptyState from '../components/EmptyState';
import { DatabaseIcon } from '../components/Icons';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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

  const navigate = useNavigate();

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

  // Database filter scoped to active type
  const allDatabasesForType = useMemo(() => {
    if (!activeGroup) return [];
    return activeGroup.databases
      .map((db) => ({ id: db.id, name: db.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [activeGroup]);

  const filterSet = useMemo(() => new Set(monitoringDatabaseFilter), [monitoringDatabaseFilter]);

  const filteredDatabases = useMemo(() => {
    if (!activeGroup) return [];
    if (filterSet.size === 0) return activeGroup.databases;
    return activeGroup.databases.filter((db) => filterSet.has(db.id));
  }, [activeGroup, filterSet]);

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
        <EmptyState
          icon={DatabaseIcon}
          message="No database monitoring configured"
          description="Enable monitoring on your databases to track trends"
          action={{ label: 'Go to Databases', onClick: () => navigate('/databases') }}
        />
      </div>
    );
  }

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
            {group.typeName}
            <span className="ml-1.5 text-xs text-slate-500">({group.databases.length})</span>
          </button>
        ))}
      </div>

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

      {/* Charts */}
      {activeGroup && filteredDatabases.length > 0 && filteredDatabases.some(db => db.data.length > 0) ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {activeGroup.queryMeta.filter(m => m.resultType === 'scalar').map(meta => {
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

            {/* Rows queries (latest snapshot tables) */}
            {activeGroup.queryMeta.filter(m => m.resultType === 'rows').map(meta => {
              const rows = getRowsSnapshot(meta.name);
              if (!rows || rows.length === 0) return null;
              const columns = Object.keys(rows[0]);
              return (
                <div key={meta.name} className="col-span-1 md:col-span-2 card">
                  <h3 className="text-sm font-medium text-white mb-4">{meta.displayName}</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                          {columns.map(col => (
                            <th key={col} className="pb-3 pr-4 font-medium">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700">
                        {rows.map((row, i) => (
                          <tr key={i} className="text-slate-300">
                            {columns.map(col => (
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
        </>
      ) : (
        <EmptyState
          icon={DatabaseIcon}
          message="No metrics data collected yet"
          description="Enable monitoring on your databases to start collecting metrics"
          action={{ label: 'Go to Databases', onClick: () => navigate('/databases') }}
        />
      )}
    </div>
  );
}

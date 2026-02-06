import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { api } from '../lib/api';
import AutoRefreshToggle from '../components/monitoring/AutoRefreshToggle';
import { DatabaseIcon } from '../components/Icons';
import { formatDistanceToNow } from 'date-fns';

interface DatabaseMonitoringSummary {
  id: string;
  name: string;
  type: string;
  typeName: string;
  serverName: string | null;
  monitoringEnabled: boolean;
  monitoringStatus: string; // connected | error | unknown
  lastCollectedAt: string | null;
  lastMonitoringError: string | null;
  latestMetrics: Record<string, unknown> | null;
  monitoringConfig: {
    queries: Array<{
      name: string;
      displayName: string;
      unit?: string;
      resultType: string;
    }>;
  } | null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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
    autoRefreshEnabled,
    setAutoRefreshEnabled,
  } = useAppStore();

  const [databases, setDatabases] = useState<DatabaseMonitoringSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async (isRefresh = false) => {
    if (!selectedEnvironment?.id) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const res = await api.get<{ databases: DatabaseMonitoringSummary[] }>(
        `/environments/${selectedEnvironment.id}/databases/monitoring-summary`
      );
      setDatabases(res.databases);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [selectedEnvironment?.id]);

  // Auto-refresh every 30 seconds if enabled
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const interval = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(interval);
  }, [selectedEnvironment?.id, autoRefreshEnabled]);

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
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-40 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const monitoredCount = databases.filter((db) => db.monitoringEnabled).length;
  const connectedCount = databases.filter((db) => db.monitoringStatus === 'connected').length;
  const errorCount = databases.filter((db) => db.monitoringStatus === 'error').length;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Database monitoring status across {selectedEnvironment.name}
        </p>
        <AutoRefreshToggle
          enabled={autoRefreshEnabled}
          onChange={setAutoRefreshEnabled}
          onRefresh={() => fetchData(true)}
          refreshing={refreshing}
        />
      </div>

      {/* Summary Stats */}
      {databases.length > 0 && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="rounded-xl border p-4 bg-blue-500/10 border-blue-500/30">
            <p className="text-slate-400 text-xs mb-1">Total</p>
            <p className="text-2xl font-bold text-blue-400">{databases.length}</p>
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
      )}

      {/* Database Grid */}
      {databases.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {databases.map((db) => (
            <div key={db.id} className="card">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-slate-800 rounded-lg mt-0.5">
                    <DatabaseIcon className="w-5 h-5 text-primary-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <StatusDot status={db.monitoringStatus} enabled={db.monitoringEnabled} />
                      <Link
                        to={`/monitoring/databases/${db.id}`}
                        className="text-lg font-semibold text-white hover:text-primary-400"
                      >
                        {db.name}
                      </Link>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="badge bg-slate-700 text-slate-300 text-xs">{db.typeName}</span>
                      {db.serverName && (
                        <span className="text-slate-500 text-sm">{db.serverName}</span>
                      )}
                    </div>
                  </div>
                </div>
                {!db.monitoringEnabled && (
                  <span className="badge bg-slate-700 text-slate-400 text-xs">Disabled</span>
                )}
              </div>

              {/* Metrics */}
              {db.monitoringEnabled && db.latestMetrics && (
                <div className="grid grid-cols-3 gap-3 mt-3">
                  {db.latestMetrics.db_size != null && (
                    <div className="p-2 rounded bg-slate-800/50">
                      <p className="text-slate-500 text-xs">DB Size</p>
                      <p className="text-white font-semibold text-sm mt-0.5">
                        {formatBytes(db.latestMetrics.db_size as number)}
                      </p>
                    </div>
                  )}
                  {db.latestMetrics.table_count != null && (
                    <div className="p-2 rounded bg-slate-800/50">
                      <p className="text-slate-500 text-xs">Tables</p>
                      <p className="text-white font-semibold text-sm mt-0.5">
                        {db.latestMetrics.table_count as number}
                      </p>
                    </div>
                  )}
                  {db.latestMetrics.active_connections != null && (
                    <div className="p-2 rounded bg-slate-800/50">
                      <p className="text-slate-500 text-xs">Connections</p>
                      <p className="text-white font-semibold text-sm mt-0.5">
                        {db.latestMetrics.active_connections as number}
                        {db.latestMetrics.max_connections != null && (
                          <span className="text-slate-500 text-xs">
                            /{db.latestMetrics.max_connections as number}
                          </span>
                        )}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Error message */}
              {db.monitoringEnabled && db.monitoringStatus === 'error' && db.lastMonitoringError && (
                <div className="mt-3 p-2 rounded bg-red-500/10 border border-red-500/20">
                  <p className="text-red-400 text-xs truncate" title={db.lastMonitoringError}>
                    {db.lastMonitoringError}
                  </p>
                </div>
              )}

              {/* Last collected */}
              {db.monitoringEnabled && (
                <div className="mt-3 text-xs text-slate-500">
                  {db.lastCollectedAt ? (
                    <>
                      Last collected{' '}
                      {formatDistanceToNow(new Date(db.lastCollectedAt), { addSuffix: true })}
                    </>
                  ) : (
                    'No data collected yet'
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
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

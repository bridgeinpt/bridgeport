import { useEffect, useState, memo } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getMonitoringOverview,
  getEnvironmentMetricsSummary,
  getDatabaseMonitoringSummary,
  type MonitoringOverviewStats,
  type MetricsSummaryServer,
  type DatabaseMonitoringSummaryItem,
} from '../lib/api';
import { ServerIcon, CubeIcon, DatabaseIcon } from '../components/Icons';
import { formatDistanceToNow } from 'date-fns';

interface FlatService {
  id: string;
  name: string;
  containerName: string;
  serverName: string;
  cpuPercent: number | null;
  memoryUsedMb: number | null;
}

export default function Monitoring() {
  const { selectedEnvironment, autoRefreshEnabled, setAutoRefreshEnabled } = useAppStore();
  const [stats, setStats] = useState<MonitoringOverviewStats | null>(null);
  const [servers, setServers] = useState<MetricsSummaryServer[]>([]);
  const [databases, setDatabases] = useState<DatabaseMonitoringSummaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async (isRefresh = false) => {
    if (!selectedEnvironment?.id) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const [overviewRes, metricsRes, dbRes] = await Promise.all([
        getMonitoringOverview(selectedEnvironment.id),
        getEnvironmentMetricsSummary(selectedEnvironment.id),
        getDatabaseMonitoringSummary(selectedEnvironment.id),
      ]);
      setStats(overviewRes.stats);
      setServers(metricsRes.servers);
      setDatabases(dbRes.databases);
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

  // Flatten services from servers
  const flatServices: FlatService[] = servers.flatMap((s) =>
    s.services
      .filter((svc) => svc.latestMetrics)
      .map((svc) => ({
        id: svc.id,
        name: svc.name,
        containerName: svc.containerName,
        serverName: s.name,
        cpuPercent: svc.latestMetrics!.cpuPercent,
        memoryUsedMb: svc.latestMetrics!.memoryUsedMb,
      }))
  );
  flatServices.sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0));

  // Sort servers: unhealthy first, then by name
  const sortedServers = [...servers].sort((a, b) => {
    const aHealthy = a.latestMetrics != null;
    const bHealthy = b.latestMetrics != null;
    if (aHealthy !== bHealthy) return aHealthy ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  // Filter and sort databases: monitored only, error first then by name
  const monitoredDbs = databases
    .filter((d) => d.monitoringEnabled)
    .sort((a, b) => {
      if (a.monitoringStatus !== b.monitoringStatus) {
        if (a.monitoringStatus === 'error') return -1;
        if (b.monitoringStatus === 'error') return 1;
      }
      return a.name.localeCompare(b.name);
    });

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-8"></div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-28 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Monitoring overview for {selectedEnvironment?.name || 'environment'}
        </p>
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

      {/* Health Sections */}
      {stats && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <HealthCard
            title="Servers Health"
            href="/monitoring/servers"
            icon={ServerIcon}
            total={stats.servers.total}
            healthy={stats.servers.healthy}
            unhealthy={stats.servers.unhealthy}
            color="blue"
          />
          <HealthCard
            title="Services Health"
            href="/monitoring/services"
            icon={CubeIcon}
            total={stats.services.total}
            healthy={stats.services.healthy}
            unhealthy={stats.services.unhealthy}
            color="green"
          />
          <HealthCard
            title="Databases Health"
            href="/monitoring/databases"
            icon={DatabaseIcon}
            total={stats.databases.total}
            healthy={stats.databases.connected}
            unhealthy={stats.databases.error}
            color="purple"
          />
        </div>
      )}

      {/* Servers Table */}
      {sortedServers.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ServerIcon className="w-4 h-4 text-blue-400" />
              <span className="text-sm font-semibold text-white">Servers</span>
            </div>
            <Link to="/monitoring/servers" className="text-xs text-primary-400 hover:text-primary-300">View all</Link>
          </div>
          <div className="panel p-0 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="text-left text-slate-400 text-xs border-b border-slate-700">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium text-right">CPU</th>
                  <th className="px-4 py-2.5 font-medium text-right">Memory</th>
                  <th className="px-4 py-2.5 font-medium text-right">Disk</th>
                  <th className="px-4 py-2.5 font-medium text-right">Load</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {sortedServers.map((s) => {
                  const m = s.latestMetrics;
                  const memPct = m?.memoryUsedMb != null && m?.memoryTotalMb
                    ? Math.round((m.memoryUsedMb / m.memoryTotalMb) * 100)
                    : null;
                  const diskPct = m?.diskUsedGb != null && m?.diskTotalGb
                    ? Math.round((m.diskUsedGb / m.diskTotalGb) * 100)
                    : null;
                  return (
                    <tr key={s.id} className="text-sm">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${m ? 'bg-green-400' : 'bg-slate-500'}`} />
                          <Link to={`/servers/${s.id}`} className="text-white hover:text-primary-400 font-medium truncate">
                            {s.name}
                          </Link>
                        </div>
                      </td>
                      {m ? (
                        <>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            <MetricValue value={m.cpuPercent} suffix="%" warn={80} crit={95} />
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            <MetricValue value={memPct} suffix="%" warn={80} crit={95} />
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            <MetricValue value={diskPct} suffix="%" warn={80} crit={95} />
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">
                            {m.loadAvg1 != null ? m.loadAvg1.toFixed(2) : '-'}
                          </td>
                        </>
                      ) : (
                        <td colSpan={4} className="px-4 py-2.5 text-slate-500 text-xs text-center">
                          No metrics
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Services Table */}
      {flatServices.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CubeIcon className="w-4 h-4 text-green-400" />
              <span className="text-sm font-semibold text-white">Services</span>
            </div>
            <Link to="/monitoring/services" className="text-xs text-primary-400 hover:text-primary-300">View all</Link>
          </div>
          <div className="panel p-0 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="text-left text-slate-400 text-xs border-b border-slate-700">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Server</th>
                  <th className="px-4 py-2.5 font-medium text-right">CPU</th>
                  <th className="px-4 py-2.5 font-medium text-right">Memory</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {flatServices.map((svc) => (
                  <tr key={svc.id} className="text-sm">
                    <td className="px-4 py-2.5">
                      <Link to={`/services/${svc.id}`} className="text-white hover:text-primary-400 font-medium truncate">
                        {svc.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-slate-400 text-xs">{svc.serverName}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      <MetricValue value={svc.cpuPercent} suffix="%" warn={80} crit={95} />
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">
                      {svc.memoryUsedMb != null ? `${Math.round(svc.memoryUsedMb)} MB` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Databases Table */}
      {monitoredDbs.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <DatabaseIcon className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-semibold text-white">Databases</span>
            </div>
            <Link to="/monitoring/databases" className="text-xs text-primary-400 hover:text-primary-300">View all</Link>
          </div>
          <div className="panel p-0 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="text-left text-slate-400 text-xs border-b border-slate-700">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Server</th>
                  <th className="px-4 py-2.5 font-medium text-right">Last Collection</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {monitoredDbs.map((db) => (
                  <tr key={db.id} className="text-sm">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          db.monitoringStatus === 'connected' ? 'bg-green-400' :
                          db.monitoringStatus === 'error' ? 'bg-red-400' : 'bg-yellow-400'
                        }`} />
                        <Link to={`/databases/${db.id}`} className="text-white hover:text-primary-400 font-medium truncate">
                          {db.name}
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="badge bg-slate-700 text-slate-300 text-xs">
                        {db.databaseType?.displayName || db.type}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-400 text-xs">{db.serverName || '-'}</td>
                    <td className="px-4 py-2.5 text-right text-slate-400 text-xs">
                      {db.lastCollectedAt
                        ? formatDistanceToNow(new Date(db.lastCollectedAt), { addSuffix: true })
                        : 'Never'}
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

interface HealthCardProps {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  total: number;
  healthy: number;
  unhealthy: number;
  color: 'blue' | 'green' | 'purple';
}

const HEALTH_COLORS = {
  blue: { icon: 'text-blue-400', bar: 'bg-blue-500' },
  green: { icon: 'text-green-400', bar: 'bg-green-500' },
  purple: { icon: 'text-purple-400', bar: 'bg-purple-500' },
} as const;

const HealthCard = memo(function HealthCard({ title, href, icon: Icon, total, healthy, unhealthy, color }: HealthCardProps) {
  const unknown = Math.max(0, total - healthy - unhealthy);
  const healthPct = total > 0 ? Math.round((healthy / total) * 100) : 0;

  return (
    <Link to={href} className="panel hover:border-slate-600 transition-colors group">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <Icon className={`w-5 h-5 ${HEALTH_COLORS[color].icon}`} />
          <span className="text-sm font-semibold text-white group-hover:text-primary-400 transition-colors">{title}</span>
        </div>
        <svg className="w-4 h-4 text-slate-500 group-hover:text-primary-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>

      {total === 0 ? (
        <p className="text-slate-500 text-sm">No resources configured</p>
      ) : (
        <>
          {/* Progress bar */}
          <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden mb-3">
            {healthy > 0 && (
              <div
                className={`h-full ${HEALTH_COLORS[color].bar} rounded-full`}
                style={{ width: `${healthPct}%` }}
              />
            )}
          </div>

          <div className="flex items-center justify-between text-xs">
            <div className="flex gap-3">
              <span className="text-green-400">{healthy} healthy</span>
              {unhealthy > 0 && <span className="text-red-400">{unhealthy} unhealthy</span>}
              {unknown > 0 && <span className="text-slate-500">{unknown} unknown</span>}
            </div>
            <span className="text-slate-400">{total} total</span>
          </div>
        </>
      )}
    </Link>
  );
});

function MetricValue({ value, suffix, warn, crit }: { value: number | null; suffix: string; warn: number; crit: number }) {
  if (value == null) return <span className="text-slate-500">-</span>;
  const rounded = Math.round(value);
  const color = rounded >= crit ? 'text-red-400' : rounded >= warn ? 'text-yellow-400' : 'text-slate-300';
  return <span className={color}>{rounded}{suffix}</span>;
}

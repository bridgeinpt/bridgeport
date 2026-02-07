import { useEffect, useState, memo } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getMonitoringOverview,
  type MonitoringOverviewStats,
} from '../lib/api';
import { ServerIcon, CubeIcon, DatabaseIcon } from '../components/Icons';

export default function Monitoring() {
  const { selectedEnvironment, autoRefreshEnabled, setAutoRefreshEnabled } = useAppStore();
  const [stats, setStats] = useState<MonitoringOverviewStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async (isRefresh = false) => {
    if (!selectedEnvironment?.id) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const overviewRes = await getMonitoringOverview(selectedEnvironment.id);
      setStats(overviewRes.stats);
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

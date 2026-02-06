import { useEffect, useState, memo } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getMonitoringOverview,
  type MonitoringOverviewStats,
} from '../lib/api';
import { ServerIcon, CubeIcon, DatabaseIcon, HeartPulseIcon } from '../components/Icons';

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
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-32 bg-slate-800 rounded-xl"></div>
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

      {/* Quick Stats */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <QuickStatCard
            label="Servers"
            value={stats.servers.total}
            healthy={stats.servers.healthy}
            unhealthy={stats.servers.unhealthy}
            color="blue"
          />
          <QuickStatCard
            label="Services"
            value={stats.services.total}
            healthy={stats.services.healthy}
            unhealthy={stats.services.unhealthy}
            color="green"
          />
          <QuickStatCard
            label="Databases"
            value={stats.databases.total}
            healthy={stats.databases.connected}
            unhealthy={stats.databases.error}
            color="purple"
          />
          <div className={`rounded-xl border p-4 ${stats.alerts > 0 ? 'bg-red-500/10 border-red-500/30' : 'bg-slate-500/10 border-slate-500/30'}`}>
            <p className="text-slate-400 text-xs mb-1">Alerts</p>
            <p className={`text-2xl font-bold ${stats.alerts > 0 ? 'text-red-400' : 'text-slate-400'}`}>{stats.alerts}</p>
          </div>
        </div>
      )}

      {/* Navigation Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SummaryCard
          title="Servers"
          description="CPU, memory, disk, and network metrics for all servers"
          href="/monitoring/servers"
          icon={ServerIcon}
          stats={stats ? {
            total: stats.servers.total,
            healthy: stats.servers.healthy,
            unhealthy: stats.servers.unhealthy,
          } : undefined}
        />
        <SummaryCard
          title="Services"
          description="Container resource usage and performance metrics"
          href="/monitoring/services"
          icon={CubeIcon}
          stats={stats ? {
            total: stats.services.total,
            healthy: stats.services.healthy,
            unhealthy: stats.services.unhealthy,
          } : undefined}
        />
        <SummaryCard
          title="Databases"
          description="Database health, connections, and performance monitoring"
          href="/monitoring/databases"
          icon={DatabaseIcon}
          stats={stats ? {
            total: stats.databases.total,
            healthy: stats.databases.connected,
            unhealthy: stats.databases.error,
          } : undefined}
        />
        <SummaryCard
          title="Health Checks"
          description="Health check logs and status for servers and services"
          href="/monitoring/health"
          icon={HeartPulseIcon}
        />
      </div>
    </div>
  );
}

interface QuickStatCardProps {
  label: string;
  value: number;
  healthy: number;
  unhealthy: number;
  color: 'blue' | 'green' | 'purple';
}

const QUICK_STAT_COLORS = {
  blue: { bg: 'bg-blue-500/10 border-blue-500/30', text: 'text-blue-400' },
  green: { bg: 'bg-green-500/10 border-green-500/30', text: 'text-green-400' },
  purple: { bg: 'bg-purple-500/10 border-purple-500/30', text: 'text-purple-400' },
} as const;

const QuickStatCard = memo(function QuickStatCard({ label, value, healthy, unhealthy, color }: QuickStatCardProps) {
  return (
    <div className={`rounded-xl border p-4 ${QUICK_STAT_COLORS[color].bg}`}>
      <p className="text-slate-400 text-xs mb-1">{label}</p>
      <p className={`text-2xl font-bold ${QUICK_STAT_COLORS[color].text}`}>{value}</p>
      <div className="flex gap-3 mt-1 text-xs">
        <span className="text-green-400">{healthy} healthy</span>
        {unhealthy > 0 && <span className="text-red-400">{unhealthy} unhealthy</span>}
      </div>
    </div>
  );
});

interface SummaryCardProps {
  title: string;
  description: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  stats?: { total: number; healthy: number; unhealthy: number };
}

const SummaryCard = memo(function SummaryCard({ title, description, href, icon: Icon, stats }: SummaryCardProps) {
  return (
    <Link
      to={href}
      className="card hover:border-slate-600 transition-colors group"
    >
      <div className="flex items-start gap-4">
        <div className="p-3 bg-slate-800 rounded-lg group-hover:bg-slate-700 transition-colors">
          <Icon className="w-6 h-6 text-primary-400" />
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-white group-hover:text-primary-400 transition-colors">
            {title}
          </h3>
          <p className="text-slate-400 text-sm mt-1">{description}</p>
          {stats && (
            <div className="flex gap-4 mt-3 text-sm">
              <span className="text-slate-300">{stats.total} total</span>
              <span className="text-green-400">{stats.healthy} healthy</span>
              {stats.unhealthy > 0 && (
                <span className="text-red-400">{stats.unhealthy} unhealthy</span>
              )}
            </div>
          )}
        </div>
        <svg className="w-5 h-5 text-slate-500 group-hover:text-primary-400 transition-colors mt-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </Link>
  );
});

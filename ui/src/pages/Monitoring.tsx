import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getEnvironmentMetricsSummary,
  type MetricsSummaryServer,
  type ServiceMetrics,
} from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

export default function Monitoring() {
  const { selectedEnvironment } = useAppStore();
  const [servers, setServers] = useState<MetricsSummaryServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async (isRefresh = false) => {
    if (!selectedEnvironment?.id) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const { servers } = await getEnvironmentMetricsSummary(selectedEnvironment.id);
      setServers(servers);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [selectedEnvironment?.id]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(interval);
  }, [selectedEnvironment?.id]);

  // Collect all services with metrics for the table
  const servicesWithMetrics: Array<{
    id: string;
    name: string;
    serverName: string;
    serverId: string;
    metrics: ServiceMetrics;
  }> = [];

  servers.forEach((server) => {
    server.services.forEach((service) => {
      if (service.latestMetrics) {
        servicesWithMetrics.push({
          id: service.id,
          name: service.name,
          serverName: server.name,
          serverId: server.id,
          metrics: service.latestMetrics,
        });
      }
    });
  });

  // Sort by CPU usage descending
  servicesWithMetrics.sort((a, b) => (b.metrics.cpuPercent || 0) - (a.metrics.cpuPercent || 0));

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-8"></div>
          <div className="grid grid-cols-2 gap-6">
            {[1, 2].map((i) => (
              <div key={i} className="h-48 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const serversWithMetrics = servers.filter((s) => s.latestMetrics);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Monitoring</h1>
          <p className="text-slate-400">
            Resource usage across {selectedEnvironment?.name || 'environment'}
          </p>
        </div>
        <button
          onClick={() => fetchData(true)}
          disabled={refreshing}
          className="btn btn-secondary"
        >
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {serversWithMetrics.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-slate-400 mb-2">No metrics available</p>
          <p className="text-slate-500 text-sm">
            Enable monitoring on your servers to see resource usage.
          </p>
          <Link to="/servers" className="btn btn-primary mt-4">
            Configure Servers
          </Link>
        </div>
      )}

      {/* Server Metrics */}
      {serversWithMetrics.length > 0 && (
        <div className="space-y-6 mb-8">
          {serversWithMetrics.map((server) => (
            <div key={server.id} className="card">
              <div className="flex items-center justify-between mb-4">
                <Link
                  to={`/servers/${server.id}`}
                  className="text-lg font-semibold text-white hover:text-primary-400"
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
                {/* CPU Gauge */}
                <MetricGauge
                  label="CPU"
                  value={server.latestMetrics?.cpuPercent ?? undefined}
                  max={100}
                  unit="%"
                  color="primary"
                />

                {/* Memory Gauge */}
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
                    server.latestMetrics?.memoryUsedMb != null
                      ? `${(server.latestMetrics.memoryUsedMb / 1024).toFixed(1)}GB`
                      : undefined
                  }
                  max={100}
                  unit="%"
                  color="green"
                />

                {/* Disk Gauge */}
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
                    server.latestMetrics?.diskUsedGb != null
                      ? `${server.latestMetrics.diskUsedGb.toFixed(0)}GB`
                      : undefined
                  }
                  max={100}
                  unit="%"
                  color="yellow"
                />

                {/* Load Average */}
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
                        className="text-white hover:text-primary-400"
                      >
                        {service.name}
                      </Link>
                    </td>
                    <td className="py-3">
                      <Link
                        to={`/servers/${service.serverId}`}
                        className="hover:text-primary-400"
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

interface MetricGaugeProps {
  label: string;
  value?: number;
  displayValue?: string;
  max: number;
  unit?: string;
  color: 'primary' | 'green' | 'yellow' | 'purple';
}

function MetricGauge({ label, value, displayValue, max, unit, color }: MetricGaugeProps) {
  const percentage = value != null ? Math.min((value / max) * 100, 100) : 0;

  const colorClasses = {
    primary: 'bg-primary-500',
    green: 'bg-green-500',
    yellow: 'bg-yellow-500',
    purple: 'bg-purple-500',
  };

  const bgColorClasses = {
    primary: 'bg-primary-900/30',
    green: 'bg-green-900/30',
    yellow: 'bg-yellow-900/30',
    purple: 'bg-purple-900/30',
  };

  return (
    <div className={`p-4 rounded-lg ${bgColorClasses[color]}`}>
      <p className="text-slate-400 text-xs mb-2">{label}</p>
      <p className="text-2xl font-bold text-white mb-3">
        {displayValue ?? (value != null ? value.toFixed(1) : '-')}
        {!displayValue && unit && value != null && (
          <span className="text-sm text-slate-400">{unit}</span>
        )}
      </p>
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${colorClasses[color]}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

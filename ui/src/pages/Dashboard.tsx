import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getEnvironment,
  getEnvironmentMetricsSummary,
  type EnvironmentWithServers,
  type MetricsSummaryServer,
} from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

export default function Dashboard() {
  const { selectedEnvironment } = useAppStore();
  const [environment, setEnvironment] = useState<EnvironmentWithServers | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummaryServer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      Promise.all([
        getEnvironment(selectedEnvironment.id),
        getEnvironmentMetricsSummary(selectedEnvironment.id),
      ])
        .then(([envRes, metricsRes]) => {
          setEnvironment(envRes.environment);
          setMetrics(metricsRes.servers);
        })
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id]);

  // Helper to get metrics for a server
  const getServerMetrics = (serverId: string) =>
    metrics.find((m) => m.id === serverId)?.latestMetrics;

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-8"></div>
          <div className="grid grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!environment) {
    return (
      <div className="p-8">
        <div className="card text-center py-12">
          <p className="text-slate-400">No environment selected</p>
        </div>
      </div>
    );
  }

  const serverCount = environment.servers.length;
  const serviceCount = environment.servers.reduce(
    (acc, s) => acc + s.services.length,
    0
  );
  const healthyServers = environment.servers.filter(
    (s) => s.status === 'healthy'
  ).length;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white capitalize">
            {environment.name} Environment
          </h1>
          <p className="text-slate-400">Overview of your infrastructure</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-slate-400 text-sm">Servers</p>
              <p className="text-3xl font-bold text-white mt-1">{serverCount}</p>
            </div>
            <div className="w-12 h-12 bg-primary-900/50 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
              </svg>
            </div>
          </div>
          <div className="mt-4">
            <span className="badge badge-success">
              {healthyServers} healthy
            </span>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-slate-400 text-sm">Services</p>
              <p className="text-3xl font-bold text-white mt-1">{serviceCount}</p>
            </div>
            <div className="w-12 h-12 bg-green-900/50 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
          </div>
          <div className="mt-4">
            <span className="badge badge-info">Running</span>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-slate-400 text-sm">Secrets</p>
              <p className="text-3xl font-bold text-white mt-1">
                {environment._count.secrets}
              </p>
            </div>
            <div className="w-12 h-12 bg-yellow-900/50 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
          </div>
          <div className="mt-4">
            <span className="badge badge-success">Encrypted</span>
          </div>
        </div>
      </div>

      {/* Server Metrics Cards */}
      {metrics.some((m) => m.latestMetrics) && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-4">Server Resources</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {metrics
              .filter((m) => m.latestMetrics)
              .map((server) => (
                <div key={server.id} className="card">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-medium text-white">{server.name}</h3>
                    <span className="text-xs text-slate-500">
                      {server.latestMetrics &&
                        formatDistanceToNow(new Date(server.latestMetrics.collectedAt), {
                          addSuffix: true,
                        })}
                    </span>
                  </div>

                  {server.latestMetrics && (
                    <div className="space-y-3">
                      {/* CPU */}
                      <div>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-slate-400">CPU</span>
                          <span className="text-white">
                            {server.latestMetrics.cpuPercent?.toFixed(1)}%
                          </span>
                        </div>
                        <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary-500 rounded-full transition-all"
                            style={{ width: `${Math.min(server.latestMetrics.cpuPercent || 0, 100)}%` }}
                          />
                        </div>
                      </div>

                      {/* Memory */}
                      {server.latestMetrics.memoryTotalMb && (
                        <div>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-slate-400">Memory</span>
                            <span className="text-white">
                              {((server.latestMetrics.memoryUsedMb || 0) / 1024).toFixed(1)} /{' '}
                              {(server.latestMetrics.memoryTotalMb / 1024).toFixed(1)} GB
                            </span>
                          </div>
                          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-green-500 rounded-full transition-all"
                              style={{
                                width: `${Math.min(
                                  ((server.latestMetrics.memoryUsedMb || 0) /
                                    server.latestMetrics.memoryTotalMb) *
                                    100,
                                  100
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Disk */}
                      {server.latestMetrics.diskTotalGb && (
                        <div>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-slate-400">Disk</span>
                            <span className="text-white">
                              {server.latestMetrics.diskUsedGb?.toFixed(0)} /{' '}
                              {server.latestMetrics.diskTotalGb.toFixed(0)} GB
                            </span>
                          </div>
                          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-yellow-500 rounded-full transition-all"
                              style={{
                                width: `${Math.min(
                                  ((server.latestMetrics.diskUsedGb || 0) /
                                    server.latestMetrics.diskTotalGb) *
                                    100,
                                  100
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Load Average */}
                      {server.latestMetrics.loadAvg1 !== null && (
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-400">Load Avg</span>
                          <span className="text-white font-mono">
                            {server.latestMetrics.loadAvg1?.toFixed(2)}{' '}
                            {server.latestMetrics.loadAvg5?.toFixed(2)}{' '}
                            {server.latestMetrics.loadAvg15?.toFixed(2)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Servers List */}
      <div className="card">
        <h2 className="text-lg font-semibold text-white mb-4">Servers</h2>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                <th className="pb-3 font-medium">Name</th>
                <th className="pb-3 font-medium">IP Address</th>
                <th className="pb-3 font-medium">Services</th>
                <th className="pb-3 font-medium">CPU</th>
                <th className="pb-3 font-medium">Memory</th>
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 font-medium">Last Checked</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {environment.servers.map((server) => {
                const serverMetrics = getServerMetrics(server.id);
                return (
                  <tr key={server.id} className="text-slate-300">
                    <td className="py-3">
                      <Link
                        to={`/servers/${server.id}`}
                        className="text-white hover:text-primary-400"
                      >
                        {server.name}
                      </Link>
                    </td>
                    <td className="py-3 font-mono text-sm">{server.hostname}</td>
                    <td className="py-3">{server.services.length}</td>
                    <td className="py-3 text-sm">
                      {serverMetrics?.cpuPercent !== null ? (
                        <span className={serverMetrics!.cpuPercent! > 80 ? 'text-red-400' : ''}>
                          {serverMetrics!.cpuPercent?.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                    </td>
                    <td className="py-3 text-sm">
                      {serverMetrics?.memoryTotalMb ? (
                        <span
                          className={
                            ((serverMetrics.memoryUsedMb || 0) / serverMetrics.memoryTotalMb) * 100 > 80
                              ? 'text-red-400'
                              : ''
                          }
                        >
                          {(
                            ((serverMetrics.memoryUsedMb || 0) / serverMetrics.memoryTotalMb) *
                            100
                          ).toFixed(0)}
                          %
                        </span>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                    </td>
                    <td className="py-3">
                      <StatusBadge status={server.status} />
                    </td>
                    <td className="py-3 text-sm text-slate-400">
                      {server.lastCheckedAt
                        ? formatDistanceToNow(new Date(server.lastCheckedAt), {
                            addSuffix: true,
                          })
                        : 'Never'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    healthy: 'badge-success',
    unhealthy: 'badge-error',
    running: 'badge-success',
    stopped: 'badge-error',
    unknown: 'badge-warning',
  };

  return <span className={`badge ${styles[status] || 'badge-info'}`}>{status}</span>;
}

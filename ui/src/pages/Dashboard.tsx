import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getEnvironment,
  getEnvironmentMetricsSummary,
  getAuditLogs,
  listDatabases,
  listDatabaseBackups,
  getBackupSchedule,
  deployService,
  checkServiceUpdates,
  type EnvironmentWithServers,
  type MetricsSummaryServer,
  type AuditLog,
  type Database,
  type DatabaseBackup,
  type BackupSchedule,
  type Service,
} from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

interface Alert {
  id: string;
  type: 'cpu' | 'memory' | 'disk' | 'unhealthy' | 'missing' | 'failed_deploy';
  severity: 'warning' | 'error';
  title: string;
  description: string;
  link: string;
}

interface ServiceWithUpdate extends Service {
  serverName: string;
  serverId: string;
}

interface DatabaseWithBackups extends Database {
  lastBackup: DatabaseBackup | null;
  schedule: BackupSchedule | null;
}

export default function Dashboard() {
  const { selectedEnvironment } = useAppStore();
  const [environment, setEnvironment] = useState<EnvironmentWithServers | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummaryServer[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [databases, setDatabases] = useState<DatabaseWithBackups[]>([]);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      Promise.all([
        getEnvironment(selectedEnvironment.id),
        getEnvironmentMetricsSummary(selectedEnvironment.id),
        getAuditLogs({ environmentId: selectedEnvironment.id, limit: 15 }),
        listDatabases(selectedEnvironment.id),
      ])
        .then(async ([envRes, metricsRes, logsRes, dbRes]) => {
          setEnvironment(envRes.environment);
          setMetrics(metricsRes.servers);
          setAuditLogs(logsRes.logs);

          // Fetch backup info for each database
          const dbsWithBackups = await Promise.all(
            dbRes.databases.map(async (db) => {
              try {
                const [backupsRes, scheduleRes] = await Promise.all([
                  listDatabaseBackups(db.id),
                  getBackupSchedule(db.id),
                ]);
                const completedBackups = backupsRes.backups.filter(b => b.status === 'completed');
                return {
                  ...db,
                  lastBackup: completedBackups[0] || null,
                  schedule: scheduleRes.schedule,
                };
              } catch {
                return { ...db, lastBackup: null, schedule: null };
              }
            })
          );
          setDatabases(dbsWithBackups);
        })
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id]);

  // Compute alerts from metrics and environment data
  const alerts = useMemo<Alert[]>(() => {
    const result: Alert[] = [];

    // High CPU from metrics
    metrics.forEach((server) => {
      if (server.latestMetrics?.cpuPercent && server.latestMetrics.cpuPercent > 80) {
        result.push({
          id: `cpu-${server.id}`,
          type: 'cpu',
          severity: server.latestMetrics.cpuPercent > 90 ? 'error' : 'warning',
          title: 'High CPU Usage',
          description: `${server.name}: ${server.latestMetrics.cpuPercent.toFixed(1)}% CPU`,
          link: `/servers/${server.id}`,
        });
      }

      // High memory
      if (
        server.latestMetrics?.memoryUsedMb &&
        server.latestMetrics?.memoryTotalMb &&
        server.latestMetrics.memoryUsedMb / server.latestMetrics.memoryTotalMb > 0.8
      ) {
        const memPercent =
          (server.latestMetrics.memoryUsedMb / server.latestMetrics.memoryTotalMb) * 100;
        result.push({
          id: `memory-${server.id}`,
          type: 'memory',
          severity: memPercent > 90 ? 'error' : 'warning',
          title: 'High Memory Usage',
          description: `${server.name}: ${memPercent.toFixed(1)}% memory`,
          link: `/servers/${server.id}`,
        });
      }

      // High disk
      if (
        server.latestMetrics?.diskUsedGb &&
        server.latestMetrics?.diskTotalGb &&
        server.latestMetrics.diskUsedGb / server.latestMetrics.diskTotalGb > 0.9
      ) {
        const diskPercent =
          (server.latestMetrics.diskUsedGb / server.latestMetrics.diskTotalGb) * 100;
        result.push({
          id: `disk-${server.id}`,
          type: 'disk',
          severity: 'error',
          title: 'High Disk Usage',
          description: `${server.name}: ${diskPercent.toFixed(1)}% disk`,
          link: `/servers/${server.id}`,
        });
      }
    });

    // Unhealthy services
    environment?.servers.forEach((server) => {
      server.services.forEach((service) => {
        if (!['running', 'healthy', 'unknown'].includes(service.status)) {
          result.push({
            id: `unhealthy-${service.id}`,
            type: 'unhealthy',
            severity: 'error',
            title: 'Unhealthy Service',
            description: `${service.name} on ${server.name}: ${service.status}`,
            link: `/services/${service.id}`,
          });
        }

        if (service.discoveryStatus === 'missing') {
          result.push({
            id: `missing-${service.id}`,
            type: 'missing',
            severity: 'warning',
            title: 'Missing Container',
            description: `${service.name} on ${server.name}: container not found`,
            link: `/services/${service.id}`,
          });
        }
      });
    });

    // Failed deployments from audit logs
    auditLogs
      .filter((log) => log.action === 'deploy' && !log.success)
      .slice(0, 3)
      .forEach((log) => {
        result.push({
          id: `deploy-${log.id}`,
          type: 'failed_deploy',
          severity: 'error',
          title: 'Failed Deployment',
          description: `${log.resourceName} failed ${formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}`,
          link: log.resourceId ? `/services/${log.resourceId}` : '/activity',
        });
      });

    return result;
  }, [metrics, environment, auditLogs]);

  // Services with available updates
  const servicesWithUpdates = useMemo<ServiceWithUpdate[]>(() => {
    return (
      environment?.servers.flatMap((server) =>
        server.services
          .filter((s) => s.latestAvailableTag && s.latestAvailableTag !== s.imageTag)
          .map((s) => ({ ...s, serverName: server.name, serverId: server.id }))
      ) || []
    );
  }, [environment]);

  // Recent activity (filtered to relevant actions)
  const recentActivity = useMemo(() => {
    const relevantActions = ['deploy', 'restart', 'health_check', 'backup', 'service.create'];
    return auditLogs
      .filter((log) => relevantActions.some((action) => log.action.includes(action)))
      .slice(0, 5);
  }, [auditLogs]);

  // Helper to get metrics for a server
  const getServerMetrics = (serverId: string) =>
    metrics.find((m) => m.id === serverId)?.latestMetrics;

  const handleDeploy = async (serviceId: string, imageTag: string) => {
    setDeploying(serviceId);
    try {
      await deployService(serviceId, { imageTag, pullImage: true });
      // Refresh environment data
      if (selectedEnvironment?.id) {
        const envRes = await getEnvironment(selectedEnvironment.id);
        setEnvironment(envRes.environment);
      }
    } catch (error) {
      console.error('Deploy failed:', error);
    } finally {
      setDeploying(null);
    }
  };

  const handleCheckAllUpdates = async () => {
    if (!environment) return;
    setCheckingUpdates(true);
    try {
      const serviceIds = environment.servers.flatMap((s) =>
        s.services.filter((svc) => svc.registryConnectionId).map((svc) => svc.id)
      );
      await Promise.all(serviceIds.map((id) => checkServiceUpdates(id)));
      // Refresh environment data
      if (selectedEnvironment?.id) {
        const envRes = await getEnvironment(selectedEnvironment.id);
        setEnvironment(envRes.environment);
      }
    } catch (error) {
      console.error('Update check failed:', error);
    } finally {
      setCheckingUpdates(false);
    }
  };

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

      {/* Alerts & Warnings */}
      {alerts.length > 0 && (
        <div className="card mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              Alerts & Warnings
              <span className="ml-2 text-sm font-normal text-slate-400">({alerts.length})</span>
            </h2>
          </div>
          <div className="space-y-3">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                      alert.severity === 'error'
                        ? 'bg-red-900/50 text-red-400'
                        : 'bg-yellow-900/50 text-yellow-400'
                    }`}
                  >
                    {alert.type === 'failed_deploy' ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    ) : alert.type === 'unhealthy' ? (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="5" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{alert.title}</p>
                    <p className="text-xs text-slate-400">{alert.description}</p>
                  </div>
                </div>
                <Link
                  to={alert.link}
                  className="btn btn-sm btn-secondary"
                >
                  View
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Available Updates */}
      {servicesWithUpdates.length > 0 && (
        <div className="card mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              Available Updates
              <span className="ml-2 text-sm font-normal text-slate-400">
                ({servicesWithUpdates.length})
              </span>
            </h2>
            <button
              onClick={handleCheckAllUpdates}
              disabled={checkingUpdates}
              className="btn btn-sm btn-secondary"
            >
              {checkingUpdates ? (
                <>
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Checking...
                </>
              ) : (
                'Check Now'
              )}
            </button>
          </div>
          <div className="space-y-3">
            {servicesWithUpdates.map((service) => (
              <div
                key={service.id}
                className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700"
              >
                <div className="flex items-center gap-4">
                  <div className="w-8 h-8 bg-primary-900/50 rounded-lg flex items-center justify-center">
                    <svg className="w-4 h-4 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{service.name}</p>
                    <p className="text-xs text-slate-400">
                      <span className="font-mono">{service.imageTag}</span>
                      <span className="mx-2 text-slate-500">&rarr;</span>
                      <span className="font-mono text-primary-400">{service.latestAvailableTag}</span>
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleDeploy(service.id, service.latestAvailableTag!)}
                  disabled={deploying === service.id}
                  className="btn btn-sm btn-primary"
                >
                  {deploying === service.id ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Deploying...
                    </>
                  ) : (
                    'Deploy'
                  )}
                </button>
              </div>
            ))}
          </div>
          {environment.servers.some((s) =>
            s.services.some((svc) => svc.lastUpdateCheckAt)
          ) && (
            <p className="text-xs text-slate-500 mt-3">
              Last checked:{' '}
              {formatDistanceToNow(
                new Date(
                  Math.max(
                    ...environment.servers.flatMap((s) =>
                      s.services
                        .filter((svc) => svc.lastUpdateCheckAt)
                        .map((svc) => new Date(svc.lastUpdateCheckAt!).getTime())
                    )
                  )
                ),
                { addSuffix: true }
              )}
            </p>
          )}
        </div>
      )}

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
                            className={`h-full rounded-full transition-all ${
                              (server.latestMetrics.cpuPercent || 0) > 80
                                ? 'bg-red-500'
                                : 'bg-primary-500'
                            }`}
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
                              className={`h-full rounded-full transition-all ${
                                ((server.latestMetrics.memoryUsedMb || 0) /
                                  server.latestMetrics.memoryTotalMb) *
                                  100 >
                                80
                                  ? 'bg-red-500'
                                  : 'bg-green-500'
                              }`}
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
                              className={`h-full rounded-full transition-all ${
                                ((server.latestMetrics.diskUsedGb || 0) /
                                  server.latestMetrics.diskTotalGb) *
                                  100 >
                                90
                                  ? 'bg-red-500'
                                  : 'bg-yellow-500'
                              }`}
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

      {/* Recent Activity */}
      {recentActivity.length > 0 && (
        <div className="card mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Recent Activity</h2>
            <Link to="/activity" className="text-sm text-primary-400 hover:text-primary-300">
              View All
            </Link>
          </div>
          <div className="space-y-3">
            {recentActivity.map((log) => (
              <div
                key={log.id}
                className="flex items-center justify-between py-2 border-b border-slate-700/50 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <ActivityIcon action={log.action} success={log.success} />
                  <div>
                    <p className="text-sm text-white">
                      <span className="capitalize">{formatAction(log.action)}</span>
                      {log.resourceName && (
                        <span className="text-slate-400"> {log.resourceName}</span>
                      )}
                      {log.details && (
                        <span className="text-slate-500 text-xs ml-1">
                          ({formatDetails(log.details)})
                        </span>
                      )}
                    </p>
                    {log.user && (
                      <p className="text-xs text-slate-500">by {log.user.name || log.user.email}</p>
                    )}
                  </div>
                </div>
                <span className="text-xs text-slate-500">
                  {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Database Backups */}
      {databases.length > 0 && (
        <div className="card mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Database Backups</h2>
            <Link to="/databases" className="text-sm text-primary-400 hover:text-primary-300">
              Manage
            </Link>
          </div>
          <div className="space-y-4">
            {databases.map((db) => (
              <div
                key={db.id}
                className="p-3 bg-slate-800/50 rounded-lg border border-slate-700"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-white">{db.name}</p>
                    <div className="flex items-center gap-4 mt-1">
                      <p className="text-xs text-slate-400">
                        Last backup:{' '}
                        {db.lastBackup ? (
                          <span className="text-slate-300">
                            {formatDistanceToNow(new Date(db.lastBackup.completedAt || db.lastBackup.createdAt), {
                              addSuffix: true,
                            })}
                          </span>
                        ) : (
                          <span className="text-yellow-400">Never</span>
                        )}
                      </p>
                      {db.schedule?.enabled && db.schedule.nextRunAt && (
                        <p className="text-xs text-slate-400">
                          Next:{' '}
                          <span className="text-slate-300">
                            {formatDistanceToNow(new Date(db.schedule.nextRunAt), { addSuffix: true })}
                          </span>
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!db.schedule?.enabled && (
                      <Link
                        to={`/databases/${db.id}`}
                        className="text-xs text-yellow-400 hover:text-yellow-300"
                      >
                        Configure schedule
                      </Link>
                    )}
                    <Link
                      to={`/databases/${db.id}`}
                      className="btn btn-sm btn-secondary"
                    >
                      Backup Now
                    </Link>
                  </div>
                </div>
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
                      {serverMetrics?.cpuPercent != null ? (
                        <span className={serverMetrics.cpuPercent > 80 ? 'text-red-400' : ''}>
                          {serverMetrics.cpuPercent.toFixed(1)}%
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

function ActivityIcon({ action, success }: { action: string; success: boolean }) {
  if (!success) {
    return (
      <div className="w-6 h-6 rounded-full bg-red-900/50 flex items-center justify-center">
        <svg className="w-3 h-3 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
    );
  }

  if (action.includes('deploy')) {
    return (
      <div className="w-6 h-6 rounded-full bg-green-900/50 flex items-center justify-center">
        <svg className="w-3 h-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }

  if (action.includes('restart')) {
    return (
      <div className="w-6 h-6 rounded-full bg-blue-900/50 flex items-center justify-center">
        <svg className="w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </div>
    );
  }

  if (action.includes('health')) {
    return (
      <div className="w-6 h-6 rounded-full bg-purple-900/50 flex items-center justify-center">
        <svg className="w-3 h-3 text-purple-400" fill="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" />
        </svg>
      </div>
    );
  }

  if (action.includes('backup')) {
    return (
      <div className="w-6 h-6 rounded-full bg-yellow-900/50 flex items-center justify-center">
        <svg className="w-3 h-3 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
        </svg>
      </div>
    );
  }

  return (
    <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center">
      <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </div>
  );
}

function formatAction(action: string): string {
  return action
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDetails(details: string): string {
  try {
    const parsed = JSON.parse(details);
    if (parsed.imageTag) return parsed.imageTag;
    if (parsed.status) return parsed.status;
    return '';
  } catch {
    return details.substring(0, 30);
  }
}

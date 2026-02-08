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
import { Modal } from '../components/Modal';
import { CheckIcon, WarningIcon, RefreshIcon, ServerIcon, CubeIcon, DatabaseIcon } from '../components/Icons';
import { useToast } from '../components/Toast';
import { TopologyDiagram } from '../components/topology';
import { useAuthStore } from '../lib/store';

interface DeployAllResult {
  serviceId: string;
  serviceName: string;
  serverName: string;
  imageTag: string;
  success: boolean;
  error?: string;
}

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
  const { selectedEnvironment, dismissedAlerts, dismissAlert, clearDismissedAlerts } = useAppStore();
  const { user } = useAuthStore();
  const toast = useToast();
  const [environment, setEnvironment] = useState<EnvironmentWithServers | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummaryServer[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [databases, setDatabases] = useState<DatabaseWithBackups[]>([]);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  // Deploy all state
  const [deployingAll, setDeployingAll] = useState(false);
  const [deployAllResults, setDeployAllResults] = useState<DeployAllResult[] | null>(null);
  const [showDeployAllResults, setShowDeployAllResults] = useState(false);

  const fetchData = async (isRefresh = false) => {
    if (!selectedEnvironment?.id) return;
    if (!isRefresh) setLoading(true);

    try {
      const [envRes, metricsRes, logsRes, dbRes] = await Promise.all([
        getEnvironment(selectedEnvironment.id),
        getEnvironmentMetricsSummary(selectedEnvironment.id),
        getAuditLogs({ environmentId: selectedEnvironment.id, limit: 15 }),
        listDatabases(selectedEnvironment.id),
      ]);

      setEnvironment(envRes.environment);
      setMetrics(metricsRes.servers);
      setAuditLogs(logsRes.logs);

      // Fetch backup info for each database (skip types without backup support)
      const dbsWithBackups = await Promise.all(
        dbRes.databases.map(async (db) => {
          if (db.databaseType?.hasBackupCommand === false) {
            return { ...db, lastBackup: null, schedule: null };
          }
          try {
            const [backupsRes, scheduleRes] = await Promise.all([
              listDatabaseBackups(db.id, 1, 0),
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
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
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

    // Unhealthy services (using Set for O(1) lookup)
    const healthyStatuses = new Set(['running', 'healthy', 'unknown']);
    environment?.servers.forEach((server) => {
      server.services.forEach((service) => {
        if (!healthyStatuses.has(service.status)) {
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

    // Filter out dismissed alerts
    return result.filter((alert) => !dismissedAlerts.includes(alert.id));
  }, [metrics, environment, auditLogs, dismissedAlerts]);

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

  // All services with server info for health grid
  const allServices = useMemo(() => {
    return (
      environment?.servers.flatMap((server) =>
        server.services.map((s) => ({ ...s, serverName: server.name }))
      ) || []
    );
  }, [environment]);

  // Service health counts
  const serviceHealthCounts = useMemo(() => {
    const healthy = allServices.filter(
      (s) => s.healthStatus === 'healthy' || s.status === 'running' || s.status === 'healthy'
    ).length;
    return { healthy, total: allServices.length };
  }, [allServices]);


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
        s.services.filter((svc) => svc.containerImage?.registryConnectionId).map((svc) => svc.id)
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

  const handleDeployAll = async () => {
    if (servicesWithUpdates.length === 0) return;

    setDeployingAll(true);
    setDeployAllResults(null);
    setShowDeployAllResults(true);

    // Deploy all services in parallel using Promise.allSettled
    const deployPromises = servicesWithUpdates.map((service) =>
      deployService(service.id, {
        imageTag: service.latestAvailableTag!,
        pullImage: true,
      }).then(
        () => ({
          serviceId: service.id,
          serviceName: service.name,
          serverName: service.serverName,
          imageTag: service.latestAvailableTag!,
          success: true as const,
        }),
        (err) => ({
          serviceId: service.id,
          serviceName: service.name,
          serverName: service.serverName,
          imageTag: service.latestAvailableTag!,
          success: false as const,
          error: err instanceof Error ? err.message : 'Deploy failed',
        })
      )
    );

    const results = await Promise.all(deployPromises);
    setDeployAllResults(results);
    setDeployingAll(false);

    // Refresh environment data
    if (selectedEnvironment?.id) {
      const envRes = await getEnvironment(selectedEnvironment.id);
      setEnvironment(envRes.environment);
    }

    const successCount = results.filter((r) => r.success).length;
    if (successCount === results.length) {
      toast.success(`Deployed all ${successCount} services successfully`);
    } else {
      toast.error(`${results.length - successCount} of ${results.length} deploys failed`);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-7 w-48 bg-slate-700 rounded mb-5"></div>
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 bg-slate-800 rounded-lg"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!environment) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-slate-400">No environment selected</p>
        </div>
      </div>
    );
  }

  const serverCount = environment.servers.length;
  const healthyServers = environment.servers.filter(
    (s) => s.status === 'healthy'
  ).length;

  return (
    <div className="p-6">
      {/* Alerts & Warnings - Moved to top */}
      {(alerts.length > 0 || dismissedAlerts.length > 0) && (
        <div className="panel mb-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              Alerts & Warnings
              <span className="ml-2 text-sm font-normal text-slate-400">({alerts.length})</span>
            </h2>
            {dismissedAlerts.length > 0 && (
              <button
                onClick={clearDismissedAlerts}
                className="text-sm text-slate-400 hover:text-white"
              >
                Show {dismissedAlerts.length} dismissed
              </button>
            )}
          </div>
          {alerts.length > 0 ? (
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
                  <div className="flex items-center gap-2">
                    <Link
                      to={alert.link}
                      className="btn btn-sm btn-secondary"
                    >
                      View
                    </Link>
                    <button
                      onClick={() => dismissAlert(alert.id)}
                      className="p-1 text-slate-400 hover:text-white"
                      title="Dismiss"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-slate-400 text-sm">All alerts dismissed. <button onClick={clearDismissedAlerts} className="text-primary-400 hover:text-primary-300">Show again</button></p>
          )}
        </div>
      )}

      {/* Service Topology Diagram */}
      {environment.servers.length > 0 && (
        <div className="mb-5">
          <TopologyDiagram
            servers={environment.servers}
            databases={databases}
            environmentId={environment.id}
            userRole={user?.role || 'viewer'}
          />
        </div>
      )}

      {/* Deploy All Results Modal */}
      <Modal
        isOpen={showDeployAllResults}
        onClose={() => {
          setShowDeployAllResults(false);
          setDeployAllResults(null);
        }}
        title="Deploy All Updates"
        size="md"
      >
        {deployAllResults === null ? (
          <div className="flex flex-col items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500 mb-4"></div>
            <p className="text-slate-400">Deploying {servicesWithUpdates.length} services...</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <div className={`p-3 rounded-lg ${
              deployAllResults.every(r => r.success)
                ? 'bg-green-500/10 border border-green-500/30'
                : deployAllResults.some(r => r.success)
                ? 'bg-yellow-500/10 border border-yellow-500/30'
                : 'bg-red-500/10 border border-red-500/30'
            }`}>
              <div className="flex items-center gap-2">
                {deployAllResults.every(r => r.success) ? (
                  <CheckIcon className="w-5 h-5 text-green-400" />
                ) : (
                  <WarningIcon className="w-5 h-5 text-yellow-400" />
                )}
                <span className={
                  deployAllResults.every(r => r.success) ? 'text-green-400' :
                  deployAllResults.some(r => r.success) ? 'text-yellow-400' : 'text-red-400'
                }>
                  {deployAllResults.filter(r => r.success).length} of {deployAllResults.length} deployed successfully
                </span>
              </div>
            </div>

            {/* Results List */}
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {deployAllResults.map((result) => (
                <div
                  key={result.serviceId}
                  className={`p-2 rounded-lg text-sm ${
                    result.success ? 'bg-slate-800/50' : 'bg-red-500/10'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-white">{result.serviceName}</span>
                      <span className="text-slate-500 mx-2">on</span>
                      <span className="text-slate-400">{result.serverName}</span>
                      <span className="text-slate-500 mx-2">→</span>
                      <span className="font-mono text-primary-400">{result.imageTag}</span>
                    </div>
                    {result.success ? (
                      <CheckIcon className="w-4 h-4 text-green-400" />
                    ) : (
                      <WarningIcon className="w-4 h-4 text-red-400" />
                    )}
                  </div>
                  {result.error && (
                    <p className="text-red-400 text-xs mt-1">{result.error}</p>
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => {
                  setShowDeployAllResults(false);
                  setDeployAllResults(null);
                }}
                className="btn btn-primary"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Available Updates */}
      {servicesWithUpdates.length > 0 && (
        <div className="panel mb-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              Available Updates
              <span className="ml-2 text-sm font-normal text-slate-400">
                ({servicesWithUpdates.length})
              </span>
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={handleDeployAll}
                disabled={deployingAll || deploying !== null}
                className="btn btn-sm btn-primary flex items-center gap-2"
              >
                <RefreshIcon className={`w-4 h-4 ${deployingAll ? 'animate-spin' : ''}`} />
                {deployingAll ? 'Deploying...' : 'Deploy All'}
              </button>
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

      {/* Servers Health Grid */}
      {environment.servers.length > 0 && (
        <div className="panel mb-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <ServerIcon className="w-5 h-5 text-blue-400" />
              Servers Health
              <span className="text-sm font-normal text-slate-400">
                ({healthyServers}/{serverCount} healthy)
              </span>
            </h2>
            <Link to="/servers" className="text-sm text-primary-400 hover:text-primary-300">
              View All
            </Link>
          </div>
          <div className="flex flex-wrap gap-2">
            {environment.servers.map((server) => {
              const isHealthy = server.status === 'healthy';
              const isWarning = server.status === 'unknown';
              const statusColor = isHealthy ? 'bg-green-500' : isWarning ? 'bg-yellow-500' : 'bg-red-500';
              return (
                <Link
                  key={server.id}
                  to={`/servers/${server.id}`}
                  className="flex items-center gap-2 px-3 py-2 bg-slate-800/50 rounded-lg border border-slate-700 hover:border-slate-600 transition-colors"
                  title={`${server.name} - ${server.status}`}
                >
                  <span className={`w-2 h-2 rounded-full ${statusColor}`} />
                  <span className="text-sm text-white">{server.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Services Health Grid */}
      {allServices.length > 0 && (
        <div className="panel mb-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <CubeIcon className="w-5 h-5 text-green-400" />
              Services Health
              <span className="text-sm font-normal text-slate-400">
                ({serviceHealthCounts.healthy}/{serviceHealthCounts.total} healthy)
              </span>
            </h2>
            <Link to="/services" className="text-sm text-primary-400 hover:text-primary-300">
              View All
            </Link>
          </div>
          <div className="flex flex-wrap gap-2">
            {allServices.map((service) => {
              const isHealthy = service.healthStatus === 'healthy' || service.status === 'running' || service.status === 'healthy';
              const isWarning = service.healthStatus === 'degraded' || service.status === 'unknown';
              const statusColor = isHealthy ? 'bg-green-500' : isWarning ? 'bg-yellow-500' : 'bg-red-500';
              return (
                <Link
                  key={service.id}
                  to={`/services/${service.id}`}
                  className="flex items-center gap-2 px-3 py-2 bg-slate-800/50 rounded-lg border border-slate-700 hover:border-slate-600 transition-colors"
                  title={`${service.name} on ${service.serverName} - ${service.healthStatus || service.status}`}
                >
                  <span className={`w-2 h-2 rounded-full ${statusColor}`} />
                  <span className="text-sm text-white">{service.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Databases Health Grid */}
      {databases.length > 0 && (
        <div className="panel mb-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <DatabaseIcon className="w-5 h-5 text-purple-400" />
              Databases Health
              {databases.some((db) => db.databaseType?.hasBackupCommand !== false) && (
              <span className="text-sm font-normal text-slate-400">
                ({databases.filter((db) => db.databaseType?.hasBackupCommand !== false && db.lastBackup !== null).length}/{databases.filter((db) => db.databaseType?.hasBackupCommand !== false).length} backed up)
              </span>
              )}
            </h2>
            <Link to="/databases" className="text-sm text-primary-400 hover:text-primary-300">
              View All
            </Link>
          </div>
          <div className="flex flex-wrap gap-2">
            {databases.map((db) => {
              const supportsBackup = db.databaseType?.hasBackupCommand !== false;
              const hasBackup = db.lastBackup !== null;
              const hasSchedule = db.schedule?.enabled;
              const statusColor = !supportsBackup ? 'bg-slate-500' : hasBackup ? 'bg-green-500' : hasSchedule ? 'bg-yellow-500' : 'bg-red-500';
              const statusTitle = !supportsBackup ? 'Backups not supported' : hasBackup ? 'Backed up' : hasSchedule ? 'Scheduled, no backup yet' : 'No backup';
              return (
                <Link
                  key={db.id}
                  to={`/databases/${db.id}`}
                  className="flex items-center gap-2 px-3 py-2 bg-slate-800/50 rounded-lg border border-slate-700 hover:border-slate-600 transition-colors"
                  title={`${db.name} - ${statusTitle}`}
                >
                  <span className={`w-2 h-2 rounded-full ${statusColor}`} />
                  <span className="text-sm text-white">{db.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Activity & Database Backups - Side by side */}
      {(recentActivity.length > 0 || databases.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">
          {/* Recent Activity */}
          {recentActivity.length > 0 && (
            <div className="panel">
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
                    <span className="text-xs text-slate-500 whitespace-nowrap ml-2">
                      {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Database Backups */}
          {databases.some((db) => db.databaseType?.hasBackupCommand !== false) && (
            <div className="panel">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Database Backups</h2>
                <Link to="/databases" className="text-sm text-primary-400 hover:text-primary-300">
                  Manage
                </Link>
              </div>
              <div className="space-y-4">
                {databases.filter((db) => db.databaseType?.hasBackupCommand !== false).map((db) => (
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
        </div>
      )}

    </div>
  );
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

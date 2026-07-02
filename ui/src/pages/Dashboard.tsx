import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getEnvironment,
  getEnvironmentMetricsSummary,
  getAuditLogs,
  listDatabases,
  listServers,
  listServices,
  getDatabaseBackupSummary,
  deployService,
  checkServiceUpdates,
  type EnvironmentDetail,
  type ServerWithServices,
  type ServerWithServicesCount,
  type ServiceWithServer,
  type MetricsSummaryServer,
  type AuditLog,
  type Database,
  type DatabaseBackupSummaryItem,
  type Service,
  type ServiceWithServerName,
} from '../lib/api';
import { formatDistanceToNow } from 'date-fns';
import { useToast } from '../components/Toast';
import { TopologyDiagram } from '../components/topology';
import { useAuthStore } from '../lib/store';
import { safeJsonParse } from '../lib/helpers';
import {
  X,
  CircleDot,
  TriangleAlert,
  RefreshCw,
  Server as ServerIcon,
  Box as CubeIcon,
  Database as DatabaseIcon,
  Check,
  HeartPulse,
  HardDriveDownload,
  Info,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Alert as AlertBox, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SpinnerIcon } from '../components/Icons';
import { cn } from '@/lib/utils';

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
  /** Target tag for the update, derived from the linked container image. */
  targetTag: string;
}

type OverallServiceStatus = 'healthy' | 'unknown' | 'unhealthy';

// Collapse one deployment's runtime/health signal into the 3-state dot the
// shared statusVariant() can map (preserves the prior 3-state semantics).
function classifyDeployment(d: { status?: string; healthStatus?: string }): OverallServiceStatus {
  if (d.healthStatus === 'healthy' || d.status === 'running' || d.status === 'healthy') return 'healthy';
  if (d.healthStatus === 'degraded' || d.status === 'unknown') return 'unknown';
  return 'unhealthy';
}

const OVERALL_SEVERITY: Record<OverallServiceStatus, number> = {
  healthy: 0,
  unknown: 1,
  unhealthy: 2,
};

// A service template's deployments; falls back to the template row itself
// (which carries the first deployment's flattened runtime fields) when the
// serviceDeployments array is absent and the row is attached to a server.
function deploymentsOf(service: ServiceWithServerName): Array<{
  serverId?: string;
  server?: { id: string; name: string };
  status?: string;
  healthStatus?: string;
  discoveryStatus?: string;
}> {
  if (service.serviceDeployments?.length) return service.serviceDeployments;
  return service.serverId ? [service] : [];
}

export default function Dashboard() {
  const { selectedEnvironment, dismissedAlerts, dismissAlert, clearDismissedAlerts } = useAppStore();
  const { user } = useAuthStore();
  const toast = useToast();
  // Each section loads independently — no top-level gate. The page chrome and
  // per-card skeletons render immediately; cards swap to their loaded content
  // as soon as their own fetch resolves.
  const [environment, setEnvironment] = useState<EnvironmentDetail | null>(null);
  const [servers, setServers] = useState<ServerWithServicesCount[]>([]);
  const [serversLoading, setServersLoading] = useState(true);
  const [services, setServices] = useState<ServiceWithServerName[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [metrics, setMetrics] = useState<MetricsSummaryServer[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [databases, setDatabases] = useState<Database[]>([]);
  const [databasesLoading, setDatabasesLoading] = useState(true);
  const [backupSummary, setBackupSummary] = useState<DatabaseBackupSummaryItem[]>([]);
  const [backupSummaryLoading, setBackupSummaryLoading] = useState(true);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  // Deploy all state
  const [deployingAll, setDeployingAll] = useState(false);
  const [deployAllResults, setDeployAllResults] = useState<DeployAllResult[] | null>(null);
  const [showDeployAllResults, setShowDeployAllResults] = useState(false);

  useEffect(() => {
    const envId = selectedEnvironment?.id;
    if (!envId) return;

    // Reset per-section state when switching environments — keeps each card's
    // skeleton visible until that section's own fetch resolves.
    setServersLoading(true);
    setServicesLoading(true);
    setDatabasesLoading(true);
    setBackupSummaryLoading(true);

    // Guard every setter so a late response from a previous env can't overwrite
    // state after the user has switched environments.
    let cancelled = false;

    // Fire every fetch in parallel; each one updates its own state on resolve.
    // There is intentionally no top-level Promise.all — a slow section must
    // not block the rest of the page.
    getEnvironment(envId)
      .then((res) => { if (!cancelled) setEnvironment(res.environment); })
      .catch((err) => { if (!cancelled) console.error('Failed to load environment:', err); });

    listServers(envId, { includeServicesCount: true, limit: 1000 })
      .then((res) => { if (!cancelled) setServers(res.servers); })
      .catch((err) => { if (!cancelled) console.error('Failed to load servers:', err); })
      .finally(() => { if (!cancelled) setServersLoading(false); });

    listServices(envId, { limit: 5000 })
      .then((res) => { if (!cancelled) setServices(res.services); })
      .catch((err) => { if (!cancelled) console.error('Failed to load services:', err); })
      .finally(() => { if (!cancelled) setServicesLoading(false); });

    getEnvironmentMetricsSummary(envId)
      .then((res) => { if (!cancelled) setMetrics(res.servers); })
      .catch((err) => { if (!cancelled) console.error('Failed to load metrics:', err); });

    getAuditLogs({ environmentId: envId, limit: 15 })
      .then((res) => { if (!cancelled) setAuditLogs(res.logs); })
      .catch((err) => { if (!cancelled) console.error('Failed to load audit logs:', err); });

    // Pass an explicit high limit so all databases in the env are loaded — the
    // server defaults to 25 via parsePaginationQuery, which would desync the
    // backed-up chip denominator and topology counts on envs with >25 DBs.
    listDatabases(envId, { limit: 1000 })
      .then((res) => { if (!cancelled) setDatabases(res.databases); })
      .catch((err) => { if (!cancelled) console.error('Failed to load databases:', err); })
      .finally(() => { if (!cancelled) setDatabasesLoading(false); });

    // Batched: one call returns last completed backup + schedule per database.
    // Replaces the previous per-database N+1 fan-out.
    getDatabaseBackupSummary(envId)
      .then((res) => { if (!cancelled) setBackupSummary(res.databases); })
      .catch((err) => { if (!cancelled) console.error('Failed to load backup summary:', err); })
      .finally(() => { if (!cancelled) setBackupSummaryLoading(false); });

    return () => { cancelled = true; };
  }, [selectedEnvironment?.id]);

  // Index backup summary by databaseId for O(1) per-card lookup.
  const backupSummaryById = useMemo(() => {
    const map = new Map<string, DatabaseBackupSummaryItem>();
    for (const item of backupSummary) map.set(item.databaseId, item);
    return map;
  }, [backupSummary]);

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

    // Unhealthy services (using Set for O(1) lookup).
    // Iterate every deployment of each service template — reading only the
    // flattened first-deployment fields would hide an unhealthy second
    // deployment. Alert ids are per-deployment so dismissing one server's
    // alert doesn't dismiss the others.
    const healthyStatuses = new Set(['running', 'healthy', 'unknown']);
    services.forEach((service) => {
      for (const d of deploymentsOf(service)) {
        const serverName = d.server?.name ?? 'unknown';
        const status = d.status ?? 'unknown';
        if (!healthyStatuses.has(status)) {
          result.push({
            id: `unhealthy-${service.id}-${d.serverId}`,
            type: 'unhealthy',
            severity: 'error',
            title: 'Unhealthy Service',
            description: `${service.name} on ${serverName}: ${status}`,
            link: `/services/${service.id}`,
          });
        }

        if (d.discoveryStatus === 'missing') {
          result.push({
            id: `missing-${service.id}-${d.serverId}`,
            type: 'missing',
            severity: 'warning',
            title: 'Missing Container',
            description: `${service.name} on ${serverName}: container not found`,
            link: `/services/${service.id}`,
          });
        }
      }
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
  }, [metrics, services, auditLogs, dismissedAlerts]);

  // Services with available updates (driven by the linked ContainerImage in 2.0).
  // The "update available" signal moved off Service onto ContainerImage when the
  // template/deployment split landed. Read `containerImage.updateAvailable` and
  // diff `containerImage.bestTag` against the current `imageTag`.
  const servicesWithUpdates = useMemo<ServiceWithUpdate[]>(() => {
    return services
      .filter(
        (s) =>
          s.containerImage?.updateAvailable &&
          s.containerImage?.bestTag &&
          s.containerImage.bestTag !== s.imageTag
      )
      .map((s) => ({
        ...s,
        serverName: s.server?.name ?? 'unknown',
        serverId: s.server?.id ?? '',
        targetTag: s.containerImage!.bestTag!,
      }));
  }, [services]);

  // Recent activity (filtered to relevant actions)
  const recentActivity = useMemo(() => {
    const relevantActions = ['deploy', 'restart', 'health_check', 'backup', 'service.create'];
    return auditLogs
      .filter((log) => relevantActions.some((action) => log.action.includes(action)))
      .slice(0, 5);
  }, [auditLogs]);

  // All services with server info for health grid: one badge per service
  // template (keeps counts consistent with `_count.services`), with `overall`
  // as the worst status across all its deployments — a healthy first
  // deployment must not mask an unhealthy second one.
  const allServices = useMemo(() => {
    return services.map((s) => {
      const deployments = deploymentsOf(s);
      // Templates with no deployments classify off the (empty) flattened
      // fields, preserving the previous single-row behavior.
      const rows = deployments.length > 0 ? deployments : [s];
      let overall: OverallServiceStatus = 'healthy';
      for (const d of rows) {
        const status = classifyDeployment(d);
        if (OVERALL_SEVERITY[status] > OVERALL_SEVERITY[overall]) overall = status;
      }
      const serverName =
        deployments.map((d) => d.server?.name ?? 'unknown').join(', ') || 'unknown';
      return { ...s, serverName, overall };
    });
  }, [services]);

  // Build a topology-friendly `ServerWithServices[]` shape from the separate
  // servers + services arrays. The topology component still expects nested services.
  // A service template fans out to one synthetic row per deployment (with that
  // deployment's runtime fields flattened on top) so it renders under EVERY
  // server it's deployed on, not just the first deployment's. Rows without a
  // serviceDeployments array fall back to the flattened first-deployment
  // serverId. Services that aren't attached to any server are skipped.
  // We cast to ServerWithServices: TopologyDiagram reads status / healthStatus /
  // containerImage / imageTag, all present on the synthetic rows.
  const serversWithServices = useMemo<ServerWithServices[]>(() => {
    const byServer = new Map<string, ServiceWithServerName[]>();
    const add = (serverId: string, row: ServiceWithServerName) => {
      const list = byServer.get(serverId);
      if (list) list.push(row);
      else byServer.set(serverId, [row]);
    };
    for (const s of services) {
      const deployments = s.serviceDeployments ?? [];
      if (deployments.length > 0) {
        for (const d of deployments) {
          add(d.serverId, {
            ...s,
            serverId: d.serverId,
            server: d.server,
            status: d.status,
            healthStatus: d.healthStatus,
            containerStatus: d.containerStatus,
            exposedPorts: d.exposedPorts,
          });
        }
      } else if (s.serverId) {
        add(s.serverId, s);
      }
    }
    return servers.map((srv) => ({
      ...srv,
      services: (byServer.get(srv.id) ?? []) as unknown as ServiceWithServer[],
    }));
  }, [servers, services]);

  // Service health counts (worst-of-deployments, same signal as the grid)
  const serviceHealthCounts = useMemo(() => {
    const healthy = allServices.filter((s) => s.overall === 'healthy').length;
    return { healthy, total: allServices.length };
  }, [allServices]);


  const refreshEnvData = async () => {
    if (!selectedEnvironment?.id) return;
    // Re-fetch env (for fresh _count), servers (for fresh status) and services
    // in parallel. Servers can become stale after a deploy (e.g. container
    // restart can flip health), so we refetch them too — not just services.
    const [envRes, serversRes, servicesRes] = await Promise.all([
      getEnvironment(selectedEnvironment.id),
      listServers(selectedEnvironment.id, { includeServicesCount: true, limit: 1000 }),
      listServices(selectedEnvironment.id, { limit: 5000 }),
    ]);
    setEnvironment(envRes.environment);
    setServers(serversRes.servers);
    setServices(servicesRes.services);
  };

  const handleDeploy = async (serviceId: string, imageTag: string) => {
    setDeploying(serviceId);
    try {
      await deployService(serviceId, { imageTag, pullImage: true });
      // Refresh env/servers/services so the dashboard reflects the new tag/status.
      await refreshEnvData();
    } catch (error) {
      console.error('Deploy failed:', error);
    } finally {
      setDeploying(null);
    }
  };

  const handleCheckAllUpdates = async () => {
    if (services.length === 0) return;
    setCheckingUpdates(true);
    try {
      const serviceIds = services
        .filter((svc) => svc.containerImage?.registryConnectionId)
        .map((svc) => svc.id);
      await Promise.all(serviceIds.map((id) => checkServiceUpdates(id)));
      await refreshEnvData();
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
        imageTag: service.targetTag,
        pullImage: true,
      }).then(
        () => ({
          serviceId: service.id,
          serviceName: service.name,
          serverName: service.serverName,
          imageTag: service.targetTag,
          success: true as const,
        }),
        (err) => ({
          serviceId: service.id,
          serviceName: service.name,
          serverName: service.serverName,
          imageTag: service.targetTag,
          success: false as const,
          error: err instanceof Error ? err.message : 'Deploy failed',
        })
      )
    );

    const results = await Promise.all(deployPromises);
    setDeployAllResults(results);
    setDeployingAll(false);

    // Refresh env/servers/services so the dashboard reflects the new tags/status.
    await refreshEnvData();

    const successCount = results.filter((r) => r.success).length;
    if (successCount === results.length) {
      toast.success(`Deployed all ${successCount} services successfully`);
    } else {
      toast.error(`${results.length - successCount} of ${results.length} deploys failed`);
    }
  };

  // Distinguish "no environment selected at all" from "environment selected
  // but its detail is still loading". The first is a terminal empty state; the
  // second renders chrome + skeletons while data streams in.
  if (!selectedEnvironment?.id) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No environment selected</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Prefer `_count.servers` from the env-detail response for the displayed total
  // (cheap, always accurate). Fall back to the page length if it's missing or
  // the env detail hasn't finished loading yet.
  // healthyServers necessarily reflects only the loaded page.
  const serverCount = environment?._count?.servers ?? servers.length;
  const healthyServers = servers.filter((s) => s.status === 'healthy').length;
  const serversTruncated = serverCount > servers.length;
  // Same idea for services. `serviceHealthCounts.total` (above) is page-length;
  // we override the displayed total here for honesty when the env has more services
  // than were loaded.
  const serviceTotal = environment?._count?.services ?? serviceHealthCounts.total;
  const servicesTruncated = serviceTotal > serviceHealthCounts.total;

  return (
    <div className="p-6">
      {/* Alerts & Warnings - Moved to top */}
      {(alerts.length > 0 || dismissedAlerts.length > 0) && (
        <Card className="mb-5">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">
              Alerts &amp; Warnings
              <span className="ml-2 text-sm font-normal text-muted-foreground">({alerts.length})</span>
            </CardTitle>
            {dismissedAlerts.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearDismissedAlerts}>
                Show {dismissedAlerts.length} dismissed
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {alerts.length > 0 ? (
              <div className="space-y-3">
                {alerts.map((alert) => (
                  <AlertBox
                    key={alert.id}
                    variant={alert.severity === 'error' ? 'destructive' : 'warning'}
                    className="flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      {alert.type === 'failed_deploy' ? (
                        <X className="size-4 shrink-0" />
                      ) : alert.type === 'unhealthy' ? (
                        <CircleDot className="size-4 shrink-0" />
                      ) : (
                        <TriangleAlert className="size-4 shrink-0" />
                      )}
                      <div>
                        <AlertTitle>{alert.title}</AlertTitle>
                        <AlertDescription>{alert.description}</AlertDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button asChild variant="secondary" size="sm">
                        <Link to={alert.link}>View</Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => dismissAlert(alert.id)}
                        title="Dismiss"
                        aria-label="Dismiss"
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  </AlertBox>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                All alerts dismissed.{' '}
                <button onClick={clearDismissedAlerts} className="text-primary hover:underline">
                  Show again
                </button>
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Service Topology Diagram. Renders a placeholder while the underlying
          servers/services fetches are still in flight so the rest of the page
          doesn't shift around once they resolve. `databases` is optional —
          topology renders without DBs and they appear when their fetch
          completes — so we don't gate on databasesLoading here. */}
      {serversLoading || servicesLoading ? (
        <Card className="mb-5">
          <CardContent className="space-y-4 pt-6">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      ) : servers.length > 0 ? (
        <div className="mb-5">
          <TopologyDiagram
            servers={serversWithServices}
            databases={databases}
            environmentId={selectedEnvironment.id}
            userRole={user?.role || 'viewer'}
          />
        </div>
      ) : null}

      {/* Deploy All Results Modal */}
      <Dialog
        open={showDeployAllResults}
        onOpenChange={(open) => {
          if (!open) {
            setShowDeployAllResults(false);
            setDeployAllResults(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deploy All Updates</DialogTitle>
          </DialogHeader>
          {deployAllResults === null ? (
            <div className="flex flex-col items-center justify-center py-8">
              <SpinnerIcon className="mb-4 size-8 text-primary" />
              <p className="text-muted-foreground">Deploying {servicesWithUpdates.length} services...</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Summary */}
              <AlertBox
                variant={
                  deployAllResults.every((r) => r.success)
                    ? 'success'
                    : deployAllResults.some((r) => r.success)
                    ? 'warning'
                    : 'destructive'
                }
              >
                {deployAllResults.every((r) => r.success) ? (
                  <Check className="size-4" />
                ) : (
                  <TriangleAlert className="size-4" />
                )}
                <AlertTitle>
                  {deployAllResults.filter((r) => r.success).length} of {deployAllResults.length} deployed
                  successfully
                </AlertTitle>
              </AlertBox>

              {/* Results List */}
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {deployAllResults.map((result) => (
                  <div
                    key={result.serviceId}
                    className={cn(
                      'rounded-lg p-2 text-sm',
                      result.success ? 'bg-muted' : 'bg-destructive/10'
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-foreground">{result.serviceName}</span>
                        <span className="mx-2 text-muted-foreground">on</span>
                        <span className="text-muted-foreground">{result.serverName}</span>
                        <span className="mx-2 text-muted-foreground">&rarr;</span>
                        <span className="font-mono text-primary">{result.imageTag}</span>
                      </div>
                      {result.success ? (
                        <Check className="size-4 text-success" />
                      ) : (
                        <TriangleAlert className="size-4 text-destructive" />
                      )}
                    </div>
                    {result.error && <p className="mt-1 text-xs text-destructive">{result.error}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {deployAllResults !== null && (
            <DialogFooter>
              <Button
                onClick={() => {
                  setShowDeployAllResults(false);
                  setDeployAllResults(null);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Available Updates */}
      {servicesWithUpdates.length > 0 && (
        <Card className="mb-5">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">
              Available Updates
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({servicesWithUpdates.length})
              </span>
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleDeployAll}
                disabled={deployingAll || deploying !== null}
              >
                <RefreshCw className={cn('size-4', deployingAll && 'animate-spin')} />
                {deployingAll ? 'Deploying...' : 'Deploy All'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCheckAllUpdates}
                disabled={checkingUpdates}
              >
                {checkingUpdates ? (
                  <>
                    <SpinnerIcon className="size-4" />
                    Checking...
                  </>
                ) : (
                  'Check Now'
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {servicesWithUpdates.map((service) => (
                <div
                  key={service.id}
                  className="flex items-center justify-between rounded-lg border bg-muted/50 p-3"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
                      <RefreshCw className="size-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{service.name}</p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono">{service.imageTag}</span>
                        <span className="mx-2 text-muted-foreground">&rarr;</span>
                        <span className="font-mono text-primary">{service.targetTag}</span>
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleDeploy(service.id, service.targetTag)}
                    disabled={deploying === service.id}
                  >
                    {deploying === service.id ? (
                      <>
                        <SpinnerIcon className="size-4" />
                        Deploying...
                      </>
                    ) : (
                      'Deploy'
                    )}
                  </Button>
                </div>
              ))}
            </div>
            {services.some((svc) => svc.containerImage?.lastCheckedAt) && (
              <p className="mt-3 text-xs text-muted-foreground">
                Last checked:{' '}
                {formatDistanceToNow(
                  new Date(
                    Math.max(
                      ...services
                        .filter((svc) => svc.containerImage?.lastCheckedAt)
                        .map((svc) => new Date(svc.containerImage!.lastCheckedAt!).getTime())
                    )
                  ),
                  { addSuffix: true }
                )}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Servers Health Grid */}
      {serversLoading ? (
        <Card className="mb-5">
          <CardContent className="space-y-4 pt-6">
            <Skeleton className="h-6 w-40" />
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-9 w-28" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : servers.length > 0 ? (
        <Card className="mb-5">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ServerIcon className="size-5 text-info" />
              Servers Health
              <span className="text-sm font-normal text-muted-foreground">
                ({healthyServers}/{serverCount} healthy{serversTruncated ? `, ${servers.length} loaded` : ''})
              </span>
            </CardTitle>
            <Link to="/servers" className="text-sm text-primary hover:underline">
              View All
            </Link>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {servers.map((server) => (
                <Link
                  key={server.id}
                  to={`/servers/${server.id}`}
                  title={`${server.name} - ${server.status}`}
                >
                  <StatusBadge
                    kind="server"
                    value={server.status}
                    label={server.name}
                    dot
                    className="px-3 py-2 text-sm"
                  />
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Services Health Grid */}
      {servicesLoading ? (
        <Card className="mb-5">
          <CardContent className="space-y-4 pt-6">
            <Skeleton className="h-6 w-40" />
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-9 w-28" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : allServices.length > 0 ? (
        <Card className="mb-5">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <CubeIcon className="size-5 text-success" />
              Services Health
              <span className="text-sm font-normal text-muted-foreground">
                ({serviceHealthCounts.healthy}/{serviceTotal} healthy{servicesTruncated ? `, ${serviceHealthCounts.total} loaded` : ''})
              </span>
            </CardTitle>
            <Link to="/services" className="text-sm text-primary hover:underline">
              View All
            </Link>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {allServices.map((service) => (
                // `overall` is the worst status across the service's
                // deployments (computed in the allServices memo).
                <Link
                  key={service.id}
                  to={`/services/${service.id}`}
                  title={`${service.name} on ${service.serverName} - ${service.overall}`}
                >
                  <StatusBadge
                    kind="overall"
                    value={service.overall}
                    label={service.name}
                    dot
                    className="px-3 py-2 text-sm"
                  />
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Databases Health Grid. Backup status is derived from the batched
          backup-summary endpoint via backupSummaryById. */}
      {databasesLoading ? (
        <Card className="mb-5">
          <CardContent className="space-y-4 pt-6">
            <Skeleton className="h-6 w-40" />
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-9 w-28" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : databases.length > 0 ? (
        <Card className="mb-5">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <DatabaseIcon className="size-5 text-primary" />
              Databases Health
              {!backupSummaryLoading && backupSummary.some((s) => s.supportsBackup) && (
                <span className="text-sm font-normal text-muted-foreground">
                  ({backupSummary.filter((s) => s.supportsBackup && s.lastBackup !== null).length}/{backupSummary.filter((s) => s.supportsBackup).length} backed up)
                </span>
              )}
            </CardTitle>
            <Link to="/databases" className="text-sm text-primary hover:underline">
              View All
            </Link>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {databases.map((db) => {
                const summary = backupSummaryById.get(db.id);
                // Fall back to the Database row's hasBackupCommand flag while the
                // batched summary is still loading.
                const supportsBackup = summary?.supportsBackup ?? (db.databaseType?.hasBackupCommand !== false);
                const hasBackup = summary?.lastBackup != null;
                const hasSchedule = summary?.schedule?.enabled === true;
                // Map backup readiness onto a backup-domain status the shared
                // statusVariant() understands (success / warning / destructive /
                // neutral), preserving the prior dot colors.
                const backupValue = !supportsBackup
                  ? 'none'
                  : backupSummaryLoading
                  ? 'running'
                  : hasBackup
                  ? 'completed'
                  : hasSchedule
                  ? 'pending'
                  : 'failed';
                const backupVariant = !supportsBackup
                  ? ('neutral' as const)
                  : backupSummaryLoading
                  ? ('info' as const)
                  : hasBackup
                  ? ('success' as const)
                  : hasSchedule
                  ? ('warning' as const)
                  : ('destructive' as const);
                const statusTitle = !supportsBackup
                  ? 'Backups not supported'
                  : backupSummaryLoading
                  ? 'Loading backup status...'
                  : hasBackup
                  ? 'Backed up'
                  : hasSchedule
                  ? 'Scheduled, no backup yet'
                  : 'No backup';
                return (
                  <Link
                    key={db.id}
                    to={`/databases/${db.id}`}
                    title={`${db.name} - ${statusTitle}`}
                  >
                    <StatusBadge
                      kind="backup"
                      value={backupValue}
                      variant={backupVariant}
                      label={db.name}
                      dot
                      className={cn('px-3 py-2 text-sm', backupSummaryLoading && 'animate-pulse')}
                    />
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Recent Activity & Database Backups - Side by side */}
      {(recentActivity.length > 0 || databases.length > 0 || backupSummaryLoading) && (
        <div className="mb-5 grid grid-cols-1 gap-5 md:grid-cols-2">
          {/* Recent Activity */}
          {recentActivity.length > 0 && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">Recent Activity</CardTitle>
                <Link to="/activity" className="text-sm text-primary hover:underline">
                  View All
                </Link>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {recentActivity.map((log) => (
                    <div
                      key={log.id}
                      className="flex items-center justify-between border-b border-border/50 py-2 last:border-0"
                    >
                      <div className="flex items-center gap-3">
                        <ActivityIcon action={log.action} success={log.success} />
                        <div>
                          <p className="text-sm text-foreground">
                            <span className="capitalize">{formatAction(log.action)}</span>
                            {log.resourceName && (
                              <span className="text-muted-foreground"> {log.resourceName}</span>
                            )}
                            {log.details && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                ({formatDetails(log.details)})
                              </span>
                            )}
                          </p>
                          {log.user && (
                            <p className="text-xs text-muted-foreground">by {log.user.name || log.user.email}</p>
                          )}
                        </div>
                      </div>
                      <span className="ml-2 whitespace-nowrap text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Database Backups */}
          {backupSummaryLoading ? (
            <Card>
              <CardContent className="space-y-4 pt-6">
                <Skeleton className="h-6 w-40" />
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : backupSummary.some((s) => s.supportsBackup) ? (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">Database Backups</CardTitle>
                <Link to="/databases" className="text-sm text-primary hover:underline">
                  Manage
                </Link>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {backupSummary.filter((s) => s.supportsBackup).map((s) => (
                    <div
                      key={s.databaseId}
                      className="rounded-lg border bg-muted/50 p-3"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-foreground">{s.name}</p>
                          <div className="mt-1 flex items-center gap-4">
                            <p className="text-xs text-muted-foreground">
                              Last backup:{' '}
                              {s.lastBackup ? (
                                <span className="text-foreground">
                                  {formatDistanceToNow(new Date(s.lastBackup.completedAt || s.lastBackup.createdAt), {
                                    addSuffix: true,
                                  })}
                                </span>
                              ) : (
                                <span className="text-warning">Never</span>
                              )}
                            </p>
                            {s.schedule?.enabled && s.schedule.nextRunAt && (
                              <p className="text-xs text-muted-foreground">
                                Next:{' '}
                                <span className="text-foreground">
                                  {formatDistanceToNow(new Date(s.schedule.nextRunAt), { addSuffix: true })}
                                </span>
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {!s.schedule?.enabled && (
                            <Link
                              to={`/databases/${s.databaseId}`}
                              className="text-xs text-warning hover:underline"
                            >
                              Configure schedule
                            </Link>
                          )}
                          <Button asChild variant="secondary" size="sm">
                            <Link to={`/databases/${s.databaseId}`}>Backup Now</Link>
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}

    </div>
  );
}

function ActivityIcon({ action, success }: { action: string; success: boolean }) {
  if (!success) {
    return (
      <div className="flex size-6 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <X className="size-3" />
      </div>
    );
  }

  if (action.includes('deploy')) {
    return (
      <div className="flex size-6 items-center justify-center rounded-full bg-success/15 text-success">
        <Check className="size-3" />
      </div>
    );
  }

  if (action.includes('restart')) {
    return (
      <div className="flex size-6 items-center justify-center rounded-full bg-info/15 text-info">
        <RefreshCw className="size-3" />
      </div>
    );
  }

  if (action.includes('health')) {
    return (
      <div className="flex size-6 items-center justify-center rounded-full bg-primary/15 text-primary">
        <HeartPulse className="size-3" />
      </div>
    );
  }

  if (action.includes('backup')) {
    return (
      <div className="flex size-6 items-center justify-center rounded-full bg-warning/15 text-warning">
        <HardDriveDownload className="size-3" />
      </div>
    );
  }

  return (
    <div className="flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <Info className="size-3" />
    </div>
  );
}

function formatAction(action: string): string {
  return action
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDetails(details: string): string {
  const parsed = safeJsonParse<Record<string, unknown> | null>(details, null);
  if (parsed === null) return details.substring(0, 30);
  if (parsed.imageTag) return parsed.imageTag as string;
  if (parsed.status) return parsed.status as string;
  return '';
}

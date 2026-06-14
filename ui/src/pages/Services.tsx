import { useEffect, useState, useMemo, lazy, Suspense } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAppStore, useAuthStore, isAdmin } from '../lib/store.js';
import { listServices, listServiceTypeCounts, deployService, checkServiceHealth, deleteService, getDependencyGraph, type ServiceWithServerName, type ExposedPort, type DependencyGraphNode, type DependencyGraphEdge, type ServiceTypeCount } from '../lib/api.js';
import { usePaginatedFetch } from '../hooks/usePaginatedFetch.js';
import { formatDistanceToNow } from 'date-fns';
import { RefreshCw, Box, HeartPulse, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { useToast } from '../components/Toast.js';
import { OperationResultsModal, type OperationResult } from '../components/OperationResultsModal.js';
import { DataPagination } from '@/components/ui/data-pagination';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { safeJsonParse } from '../lib/helpers.js';

// Lazy load DependencyFlow to avoid loading @xyflow/react (~80KB) until needed
const DependencyFlow = lazy(() =>
  import('../components/DependencyFlow').then((m) => ({ default: m.DependencyFlow }))
);

interface ServiceWithServer extends ServiceWithServerName {
  serverName: string;
}

function parseExposedPorts(portsJson: string | null): ExposedPort[] {
  return safeJsonParse(portsJson, [] as ExposedPort[]);
}

function formatPorts(ports: ExposedPort[], maxDisplay = 2): string {
  if (ports.length === 0) return '-';
  const displayed = ports.slice(0, maxDisplay).map(p =>
    p.host ? `${p.host}:${p.container}` : `${p.container}`
  );
  if (ports.length > maxDisplay) {
    displayed.push(`+${ports.length - maxDisplay}`);
  }
  return displayed.join(', ');
}

type TabType = 'list' | 'dependencies';

// URL sentinel for the "no type" filter chip (services with no serviceTypeId).
// ServiceType ids are cuids, so this literal can never collide with a real id.
const NO_TYPE_FILTER = '__none__';

export default function Services() {
  const { selectedEnvironment, servicesShowUpdatesOnly, setServicesShowUpdatesOnly } = useAppStore();
  const { user } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();

  // Get tab from URL hash, default to 'list'
  const getTabFromHash = (): TabType => {
    const hash = location.hash.replace('#', '');
    return hash === 'dependencies' ? 'dependencies' : 'list';
  };

  const { items: services, total, loading, currentPage, pageSize, totalPages, setCurrentPage, setPageSize, reload } =
    usePaginatedFetch<ServiceWithServer>({
      fetcher: ({ limit, offset }) =>
        listServices(selectedEnvironment!.id, { limit, offset }).then(r => ({
          items: r.services.map((svc) => ({ ...svc, serverName: svc.server?.name || '' })),
          total: r.total,
        })),
      deps: [selectedEnvironment?.id],
      enabled: !!selectedEnvironment?.id,
    });

  const activeTab = getTabFromHash();

  const setActiveTab = (tab: TabType) => {
    navigate({ hash: tab }, { replace: true });
  };

  // Bulk deploy state
  const [bulkDeploying, setBulkDeploying] = useState(false);
  const [deployResults, setDeployResults] = useState<OperationResult[] | null>(null);
  const [showDeployResults, setShowDeployResults] = useState(false);

  // Action state
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [serviceToDelete, setServiceToDelete] = useState<ServiceWithServer | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Dependency graph data
  const [dependencyNodes, setDependencyNodes] = useState<Map<string, DependencyGraphNode>>(new Map());
  const [graphNodes, setGraphNodes] = useState<DependencyGraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<DependencyGraphEdge[]>([]);
  const [deploymentOrder, setDeploymentOrder] = useState<string[][]>([]);

  // Service types in use across the environment, for the filter chips.
  const [serviceTypeCounts, setServiceTypeCounts] = useState<ServiceTypeCount[]>([]);

  // Active filter (URL-persisted). null = "All"; NO_TYPE_FILTER = services with no type;
  // any other string = a serviceTypeId to exact-match.
  // URL params: type filter is shareable + survives reload. `servicesShowUpdatesOnly`
  // above is a per-user preference, kept in Zustand — intentionally different mechanisms.
  const activeTypeFilter = searchParams.get('type');

  const setActiveTypeFilter = (next: string | null) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === null) {
          params.delete('type');
        } else {
          params.set('type', next);
        }
        return params;
      },
      { replace: true }
    );
  };

  // Dependency graph + type tag list are environment-wide — fetch once per environment, not on pagination change
  useEffect(() => {
    if (selectedEnvironment?.id) {
      getDependencyGraph(selectedEnvironment.id)
        .catch(() => ({ nodes: [], edges: [], deploymentOrder: [] }))
        .then((graph) => {
          setGraphNodes(graph.nodes);
          setGraphEdges(graph.edges);
          setDeploymentOrder(graph.deploymentOrder);

          const nodeMap = new Map<string, DependencyGraphNode>();
          graph.nodes.forEach((node) => nodeMap.set(node.id, node));
          setDependencyNodes(nodeMap);
        });

      listServiceTypeCounts(selectedEnvironment.id)
        .then(({ types }) => setServiceTypeCounts(types))
        .catch(() => setServiceTypeCounts([]));
    }
  }, [selectedEnvironment?.id]);

  // Clear any stale type filter when the environment changes — a tag from
  // env A won't necessarily exist in env B, and leaving it set would hide
  // every service silently.
  useEffect(() => {
    if (activeTypeFilter !== null) {
      setActiveTypeFilter(null);
    }
    // Intentionally only reacts to environment changes, not the filter itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEnvironment?.id]);

  // Services with available updates (memoized).
  // After the 2.0 template split, update detection lives on the linked ContainerImage.
  const servicesWithUpdates = useMemo(
    () =>
      services.filter(
        (s) => s.containerImage?.updateAvailable && s.containerImage?.bestTag && s.containerImage.bestTag !== s.imageTag
      ),
    [services]
  );

  // Count of services without a service type — drives whether to surface the "No type" chip.
  const noTypeCount = useMemo(
    () => services.filter((s) => !s.serviceTypeId).length,
    [services]
  );

  // Filtered services based on "show updates only" toggle + active type filter (memoized).
  // The active filter holds a serviceTypeId (or the NO_TYPE_FILTER sentinel).
  const filteredServices = useMemo(() => {
    const base = servicesShowUpdatesOnly ? servicesWithUpdates : services;
    if (activeTypeFilter === null) return base;
    if (activeTypeFilter === NO_TYPE_FILTER) {
      return base.filter((s) => !s.serviceTypeId);
    }
    return base.filter((s) => s.serviceTypeId === activeTypeFilter);
  }, [servicesShowUpdatesOnly, servicesWithUpdates, services, activeTypeFilter]);

  const handleBulkDeployAll = async () => {
    if (servicesWithUpdates.length === 0) return;

    setBulkDeploying(true);
    setDeployResults(null);
    setShowDeployResults(true);

    // Deploy all services in parallel using Promise.all
    const deployPromises = servicesWithUpdates.map((service) => {
      const targetTag = service.containerImage?.bestTag ?? service.imageTag;
      return deployService(service.id, {
        imageTag: targetTag,
        pullImage: true,
      }).then(
        (): OperationResult => ({
          id: service.id,
          label: service.name,
          sublabel: service.serverName,
          detail: targetTag,
          success: true,
        }),
        (err): OperationResult => ({
          id: service.id,
          label: service.name,
          sublabel: service.serverName,
          detail: targetTag,
          success: false,
          error: err instanceof Error ? err.message : 'Deploy failed',
        })
      );
    });

    const results = await Promise.all(deployPromises);
    setDeployResults(results);
    setBulkDeploying(false);

    // Reload services
    reload();

    const successCount = results.filter((r) => r.success).length;
    if (successCount === results.length) {
      toast.success(`Deployed ${successCount} services successfully`);
    } else {
      toast.error(`${results.length - successCount} of ${results.length} deploys failed`);
    }
  };

  const handleHealthCheck = async (serviceId: string) => {
    setActionLoading(serviceId);
    try {
      await checkServiceHealth(serviceId);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Health check failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!serviceToDelete) return;
    setDeleting(true);
    try {
      await deleteService(serviceToDelete.id);
      reload();
      toast.success(`Service "${serviceToDelete.name}" deleted`);
      setServiceToDelete(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete service');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-5">
        <div className="flex items-center gap-4">
          {activeTab === 'list' && servicesWithUpdates.length > 0 && (
            <>
              <Label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                <Switch
                  checked={servicesShowUpdatesOnly}
                  onCheckedChange={setServicesShowUpdatesOnly}
                />
                Show updates only ({servicesWithUpdates.length})
              </Label>
              <Button onClick={handleBulkDeployAll} disabled={bulkDeploying}>
                <RefreshCw className={cn('size-4', bulkDeploying && 'animate-spin')} />
                Update All ({servicesWithUpdates.length})
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabType)} className="mb-6">
        <TabsList>
          <TabsTrigger value="list">List</TabsTrigger>
          <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!serviceToDelete} onOpenChange={(open) => !open && setServiceToDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Service</DialogTitle>
            <DialogDescription>
              This will remove the service from BRIDGEPORT. The container will not be stopped or
              removed. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-foreground">
            Are you sure you want to delete{' '}
            <span className="font-semibold">{serviceToDelete?.name}</span>?
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setServiceToDelete(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete Service'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Deploy Results Modal */}
      <OperationResultsModal
        isOpen={showDeployResults}
        onClose={() => {
          setShowDeployResults(false);
          setDeployResults(null);
        }}
        title="Bulk Deploy"
        loadingMessage="Deploying services..."
        loadingCount={servicesWithUpdates.length}
        results={deployResults}
      />

      {activeTab === 'dependencies' ? (
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-96 rounded-lg border bg-card/40">
              <div className="size-8 animate-spin rounded-full border-b-2 border-primary"></div>
            </div>
          }
        >
          <DependencyFlow
            nodes={graphNodes}
            edges={graphEdges}
            deploymentOrder={deploymentOrder}
          />
        </Suspense>
      ) : (
      <div className="space-y-4">
        {/* Service-type filter chips. Hidden when no service in the env has a type and there are no untyped services to differentiate either. */}
        {(serviceTypeCounts.length > 0 || noTypeCount > 0) && (
          <div
            role="group"
            aria-label="Filter services by type"
            className="flex flex-wrap items-center gap-2"
          >
            <Button
              type="button"
              size="sm"
              variant={activeTypeFilter === null ? 'secondary' : 'outline'}
              onClick={() => setActiveTypeFilter(null)}
              aria-pressed={activeTypeFilter === null}
              className="rounded-full"
            >
              All ({services.length})
            </Button>
            {serviceTypeCounts.map((t) => {
              const active = activeTypeFilter === t.id;
              return (
                <Button
                  key={t.id}
                  type="button"
                  size="sm"
                  variant={active ? 'secondary' : 'outline'}
                  onClick={() => setActiveTypeFilter(t.id)}
                  aria-pressed={active}
                  className="rounded-full"
                >
                  {t.displayName} ({t.count})
                </Button>
              );
            })}
            {noTypeCount > 0 && (
              <Button
                type="button"
                size="sm"
                variant={activeTypeFilter === NO_TYPE_FILTER ? 'secondary' : 'outline'}
                onClick={() => setActiveTypeFilter(NO_TYPE_FILTER)}
                aria-pressed={activeTypeFilter === NO_TYPE_FILTER}
                className="rounded-full italic"
              >
                No type ({noTypeCount})
              </Button>
            )}
          </div>
        )}
        {filteredServices.length > 0 ? (
          <>
            {filteredServices.map((service) => {
              const ports = parseExposedPorts(service.exposedPorts ?? null);
              const targetTag = service.containerImage?.bestTag ?? null;
              const hasUpdate = !!(
                service.containerImage?.updateAvailable && targetTag && targetTag !== service.imageTag
              );
              const depNode = dependencyNodes.get(service.id);
              const hasDependencies = depNode && (depNode.dependencyCount > 0 || depNode.dependentCount > 0);
              const hasContainerImage = depNode?.containerImage;
              const containerStatus = service.containerStatus ?? service.status ?? 'unknown';
              return (
                <Card key={service.id} className={cn('p-4', hasUpdate && 'border-success/30')}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                      <div className="p-3 bg-success/10 rounded-lg">
                        <Box className="size-6 text-success" />
                      </div>
                      <div>
                        {/* Row 1: Name + badges */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link
                            to={`/services/${service.id}`}
                            className="text-lg font-semibold text-foreground hover:text-primary"
                          >
                            {service.name}
                          </Link>
                          <StatusBadge kind="container" value={containerStatus} />
                          <StatusBadge kind="health" value={service.healthStatus || 'unknown'} />
                          {hasUpdate && (
                            <Badge variant="success">Update available</Badge>
                          )}
                          {hasContainerImage && (
                            <span
                              className="size-2 bg-primary rounded-full"
                              title="Linked to container image"
                            />
                          )}
                          {hasDependencies && (
                            <span
                              className="flex items-center gap-0.5 text-xs text-muted-foreground"
                              title={`${depNode.dependencyCount} dependencies, ${depNode.dependentCount} dependents`}
                            >
                              {depNode.dependencyCount > 0 && (
                                <span className="flex items-center text-success">
                                  <ArrowUp className="size-3" />
                                  {depNode.dependencyCount}
                                </span>
                              )}
                              {depNode.dependentCount > 0 && (
                                <span className="flex items-center text-info">
                                  <ArrowDown className="size-3" />
                                  {depNode.dependentCount}
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                        {/* Row 2: Server + Type + Image */}
                        <p className="text-muted-foreground text-sm mt-1">
                          {(() => {
                            // Prefer deployment-shaped servers from the API
                            // (post-Service-split shape); fall back to the
                            // single `server` field that the back-compat layer
                            // surfaces for legacy callers.
                            const servers = service.serviceDeployments
                              ?.map((d) => d.server?.name)
                              .filter((n): n is string => !!n) ?? [];
                            if (servers.length === 0 && service.server?.name) {
                              servers.push(service.server.name);
                            }
                            if (servers.length === 0) {
                              return <span>No deployments</span>;
                            }
                            return <span>{servers.join(', ')}</span>;
                          })()}
                          <span className="text-muted-foreground/70"> · </span>
                          <Badge variant="neutral">
                            {service.serviceType?.displayName || 'Generic'}
                          </Badge>
                          <span className="text-muted-foreground/70"> · </span>
                          <span className="font-mono">
                            {service.containerImage?.imageName?.split('/').pop() || 'unknown'}
                            :<span className="text-primary">{service.imageTag}</span>
                          </span>
                          {hasUpdate && (
                            <>
                              <span className="text-muted-foreground/70"> → </span>
                              <span className="font-mono text-success">{targetTag}</span>
                            </>
                          )}
                        </p>
                        {/* Row 3: Ports + Container + Last checked */}
                        <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                          {ports.length > 0 && <span>Ports: {formatPorts(ports)}</span>}
                          {service.containerName && <span className="font-mono">{service.containerName}</span>}
                          <span>
                            {service.lastCheckedAt
                              ? `Checked ${formatDistanceToNow(new Date(service.lastCheckedAt), { addSuffix: true })}`
                              : 'Never checked'}
                          </span>
                        </div>
                      </div>
                    </div>
                    {/* Actions - hybrid pattern */}
                    <div className="flex items-center gap-2">
                      {hasUpdate && targetTag && (
                        <Button
                          size="sm"
                          onClick={() => {
                            deployService(service.id, {
                              imageTag: targetTag,
                              pullImage: true,
                            }).then(() => {
                              toast.success(`Deployed ${service.name} to ${targetTag}`);
                              reload();
                            }).catch((err) => {
                              toast.error(err instanceof Error ? err.message : 'Deploy failed');
                            });
                          }}
                        >
                          Deploy {targetTag}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleHealthCheck(service.id)}
                        disabled={actionLoading === service.id}
                        title="Health Check"
                      >
                        <HeartPulse className="size-4" />
                      </Button>
                      {isAdmin(user) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setServiceToDelete(service)}
                          className="text-muted-foreground hover:text-destructive"
                          title="Delete"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
            <DataPagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={total}
              pageSize={pageSize}
              onPageChange={setCurrentPage}
              onPageSizeChange={setPageSize}
            />
          </>
        ) : (
          <EmptyState
            icon={Box}
            message="No services discovered"
            description="Go to a server and click 'Discover Containers' to find services"
          />
        )}
      </div>
      )}
    </div>
  );
}

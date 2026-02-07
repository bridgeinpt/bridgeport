import { useEffect, useState, useMemo, lazy, Suspense } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAppStore, useAuthStore, isAdmin } from '../lib/store.js';
import { getEnvironment, deployService, checkServiceHealth, deleteService, getDependencyGraph, type Service, type ExposedPort, type DependencyGraphNode, type DependencyGraphEdge } from '../lib/api.js';
import { formatDistanceToNow } from 'date-fns';
import { getContainerStatusColor, getHealthStatusColor } from '../lib/status.js';
import { RefreshIcon, CubeIcon, HeartPulseIcon, TrashIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';
import Pagination from '../components/Pagination.js';
import { usePagination } from '../hooks/usePagination.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { EmptyState } from '../components/EmptyState.js';
import { OperationResultsModal, type OperationResult } from '../components/OperationResultsModal.js';
import { Modal } from '../components/Modal.js';

// Lazy load DependencyFlow to avoid loading @xyflow/react (~80KB) until needed
const DependencyFlow = lazy(() =>
  import('../components/DependencyFlow').then((m) => ({ default: m.DependencyFlow }))
);

interface ServiceWithServer extends Service {
  serverName: string;
}

function parseExposedPorts(portsJson: string | null): ExposedPort[] {
  if (!portsJson) return [];
  try {
    return JSON.parse(portsJson);
  } catch {
    return [];
  }
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

export default function Services() {
  const { selectedEnvironment, servicesShowUpdatesOnly, setServicesShowUpdatesOnly } = useAppStore();
  const { user } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  // Get tab from URL hash, default to 'list'
  const getTabFromHash = (): TabType => {
    const hash = location.hash.replace('#', '');
    return hash === 'dependencies' ? 'dependencies' : 'list';
  };

  const [services, setServices] = useState<ServiceWithServer[]>([]);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      Promise.all([
        getEnvironment(selectedEnvironment.id),
        getDependencyGraph(selectedEnvironment.id).catch(() => ({ nodes: [], edges: [], deploymentOrder: [] })),
      ])
        .then(([{ environment }, graph]) => {
          const allServices: ServiceWithServer[] = [];
          environment.servers.forEach((server) => {
            server.services.forEach((service) => {
              allServices.push({
                ...service,
                serverName: server.name,
              });
            });
          });
          setServices(allServices);

          // Store full graph data for visualization
          setGraphNodes(graph.nodes);
          setGraphEdges(graph.edges);
          setDeploymentOrder(graph.deploymentOrder);

          // Build map of dependency nodes
          const nodeMap = new Map<string, DependencyGraphNode>();
          graph.nodes.forEach((node) => nodeMap.set(node.id, node));
          setDependencyNodes(nodeMap);
        })
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id]);

  // Services with available updates (memoized)
  const servicesWithUpdates = useMemo(
    () => services.filter((s) => s.latestAvailableTag && s.latestAvailableTag !== s.imageTag),
    [services]
  );

  // Filtered services based on "show updates only" toggle (memoized)
  const filteredServices = useMemo(
    () => (servicesShowUpdatesOnly ? servicesWithUpdates : services),
    [servicesShowUpdatesOnly, servicesWithUpdates, services]
  );

  const handleBulkDeployAll = async () => {
    if (servicesWithUpdates.length === 0) return;

    setBulkDeploying(true);
    setDeployResults(null);
    setShowDeployResults(true);

    // Deploy all services in parallel using Promise.all
    const deployPromises = servicesWithUpdates.map((service) =>
      deployService(service.id, {
        imageTag: service.latestAvailableTag!,
        pullImage: true,
      }).then(
        (): OperationResult => ({
          id: service.id,
          label: service.name,
          sublabel: service.serverName,
          detail: service.latestAvailableTag!,
          success: true,
        }),
        (err): OperationResult => ({
          id: service.id,
          label: service.name,
          sublabel: service.serverName,
          detail: service.latestAvailableTag!,
          success: false,
          error: err instanceof Error ? err.message : 'Deploy failed',
        })
      )
    );

    const results = await Promise.all(deployPromises);
    setDeployResults(results);
    setBulkDeploying(false);

    // Reload services
    if (selectedEnvironment?.id) {
      const { environment } = await getEnvironment(selectedEnvironment.id);
      const allServices: ServiceWithServer[] = [];
      environment.servers.forEach((server) => {
        server.services.forEach((service) => {
          allServices.push({ ...service, serverName: server.name });
        });
      });
      setServices(allServices);
    }

    const successCount = results.filter((r) => r.success).length;
    if (successCount === results.length) {
      toast.success(`Deployed ${successCount} services successfully`);
    } else {
      toast.error(`${results.length - successCount} of ${results.length} deploys failed`);
    }
  };

  const reloadServices = async () => {
    if (!selectedEnvironment?.id) return;
    const { environment } = await getEnvironment(selectedEnvironment.id);
    const allServices: ServiceWithServer[] = [];
    environment.servers.forEach((server) => {
      server.services.forEach((svc) => {
        allServices.push({ ...svc, serverName: server.name });
      });
    });
    setServices(allServices);
  };

  const handleHealthCheck = async (serviceId: string) => {
    setActionLoading(serviceId);
    try {
      const result = await checkServiceHealth(serviceId);
      setServices((prev) =>
        prev.map((s) =>
          s.id === serviceId
            ? { ...s, healthStatus: result.healthStatus, containerStatus: result.containerStatus, lastCheckedAt: new Date().toISOString() }
            : s
        )
      );
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
      setServices((prev) => prev.filter((s) => s.id !== serviceToDelete.id));
      toast.success(`Service "${serviceToDelete.name}" deleted`);
      setServiceToDelete(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete service');
    } finally {
      setDeleting(false);
    }
  };

  // Pagination
  const {
    paginatedData,
    currentPage,
    totalPages,
    totalItems,
    pageSize,
    setPage,
    setPageSize,
  } = usePagination({ data: filteredServices, defaultPageSize: 25 });

  if (loading) {
    return <LoadingSkeleton rows={3} rowHeight="h-20" />;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          All services in {selectedEnvironment?.name}
        </p>
        <div className="flex items-center gap-4">
          {activeTab === 'list' && servicesWithUpdates.length > 0 && (
            <>
              <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={servicesShowUpdatesOnly}
                  onChange={(e) => setServicesShowUpdatesOnly(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-primary-600 focus:ring-primary-500"
                />
                Show updates only ({servicesWithUpdates.length})
              </label>
              <button
                onClick={handleBulkDeployAll}
                disabled={bulkDeploying}
                className="btn btn-primary flex items-center gap-2"
              >
                <RefreshIcon className={`w-4 h-4 ${bulkDeploying ? 'animate-spin' : ''}`} />
                Update All ({servicesWithUpdates.length})
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-700 mb-6">
        <button
          onClick={() => setActiveTab('list')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            activeTab === 'list'
              ? 'border-brand-600 text-white'
              : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          List
        </button>
        <button
          onClick={() => setActiveTab('dependencies')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            activeTab === 'dependencies'
              ? 'border-brand-600 text-white'
              : 'border-transparent text-slate-400 hover:text-white'
          }`}
        >
          Dependencies
        </button>
      </div>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!serviceToDelete}
        onClose={() => setServiceToDelete(null)}
        title="Delete Service"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-slate-300">
            Are you sure you want to delete <span className="font-semibold text-white">{serviceToDelete?.name}</span>?
          </p>
          <p className="text-sm text-slate-400">
            This will remove the service from BridgePort. The container will not be stopped or removed. This action cannot be undone.
          </p>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setServiceToDelete(null)}
              className="btn btn-ghost"
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="btn bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? 'Deleting...' : 'Delete Service'}
            </button>
          </div>
        </div>
      </Modal>

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
            <div className="flex items-center justify-center h-96 bg-slate-800 rounded-lg">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
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
        {filteredServices.length > 0 ? (
          <>
            {paginatedData.map((service) => {
              const ports = parseExposedPorts(service.exposedPorts);
              const hasUpdate = service.latestAvailableTag && service.latestAvailableTag !== service.imageTag;
              const depNode = dependencyNodes.get(service.id);
              const hasDependencies = depNode && (depNode.dependencyCount > 0 || depNode.dependentCount > 0);
              const hasContainerImage = depNode?.containerImage;
              return (
                <div key={service.id} className={`panel ${hasUpdate ? 'border-green-500/30' : ''}`}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                      <div className="p-3 bg-slate-800 rounded-lg">
                        <CubeIcon className="w-6 h-6 text-primary-400" />
                      </div>
                      <div>
                        {/* Row 1: Name + badges */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link
                            to={`/services/${service.id}`}
                            className="text-lg font-semibold text-white hover:text-primary-400"
                          >
                            {service.name}
                          </Link>
                          <span className={`badge text-xs ${getContainerStatusColor(service.containerStatus || service.status)}`}>
                            {service.containerStatus || service.status}
                          </span>
                          <span className={`badge text-xs ${getHealthStatusColor(service.healthStatus || 'unknown')}`}>
                            {service.healthStatus || 'unknown'}
                          </span>
                          {hasUpdate && (
                            <span className="badge bg-green-500/20 text-green-400 text-xs">Update available</span>
                          )}
                          {hasContainerImage && (
                            <span
                              className="w-2 h-2 bg-primary-400 rounded-full"
                              title="Linked to container image"
                            />
                          )}
                          {hasDependencies && (
                            <span
                              className="flex items-center gap-0.5 text-xs text-slate-500"
                              title={`${depNode.dependencyCount} dependencies, ${depNode.dependentCount} dependents`}
                            >
                              {depNode.dependencyCount > 0 && (
                                <span className="text-green-400">↑{depNode.dependencyCount}</span>
                              )}
                              {depNode.dependentCount > 0 && (
                                <span className="text-blue-400">↓{depNode.dependentCount}</span>
                              )}
                            </span>
                          )}
                        </div>
                        {/* Row 2: Server + Type + Image */}
                        <p className="text-slate-400 text-sm mt-1">
                          <Link
                            to={`/servers/${service.serverId}`}
                            className="hover:text-primary-400"
                          >
                            {service.serverName}
                          </Link>
                          <span className="text-slate-500"> · </span>
                          <span>{service.serviceType?.displayName || 'Generic'}</span>
                          <span className="text-slate-500"> · </span>
                          <span className="font-mono">
                            {service.containerImage?.imageName?.split('/').pop() || 'unknown'}
                            :<span className="text-primary-400">{service.imageTag}</span>
                          </span>
                          {hasUpdate && (
                            <>
                              <span className="text-slate-500"> → </span>
                              <span className="font-mono text-green-400">{service.latestAvailableTag}</span>
                            </>
                          )}
                        </p>
                        {/* Row 3: Ports + Container + Last checked */}
                        <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                          {ports.length > 0 && <span>Ports: {formatPorts(ports)}</span>}
                          <span className="font-mono">{service.containerName}</span>
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
                      {hasUpdate && (
                        <button
                          onClick={() => {
                            deployService(service.id, {
                              imageTag: service.latestAvailableTag!,
                              pullImage: true,
                            }).then(() => {
                              toast.success(`Deployed ${service.name} to ${service.latestAvailableTag}`);
                              reloadServices();
                            }).catch((err) => {
                              toast.error(err instanceof Error ? err.message : 'Deploy failed');
                            });
                          }}
                          className="btn btn-primary text-sm"
                        >
                          Deploy {service.latestAvailableTag}
                        </button>
                      )}
                      <button
                        onClick={() => handleHealthCheck(service.id)}
                        disabled={actionLoading === service.id}
                        className="p-1.5 text-slate-400 hover:text-white rounded"
                        title="Health Check"
                      >
                        <HeartPulseIcon className="w-4 h-4" />
                      </button>
                      {isAdmin(user) && (
                        <button
                          onClick={() => setServiceToDelete(service)}
                          className="p-1.5 text-slate-400 hover:text-red-400 rounded"
                          title="Delete"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={totalItems}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </>
        ) : (
          <EmptyState
            icon={CubeIcon}
            message="No services discovered"
            description="Go to a server and click 'Discover Containers' to find services"
          />
        )}
      </div>
      )}
    </div>
  );
}

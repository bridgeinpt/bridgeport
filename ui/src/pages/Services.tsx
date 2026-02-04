import { useEffect, useState, useMemo, lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store.js';
import { getEnvironment, deployService, getDependencyGraph, type Service, type ExposedPort, type DependencyGraphNode, type DependencyGraphEdge } from '../lib/api.js';
import { formatDistanceToNow } from 'date-fns';
import { getContainerStatusColor, getHealthStatusColor } from '../lib/status.js';
import { RefreshIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';
import Pagination from '../components/Pagination.js';
import { usePagination } from '../hooks/usePagination.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { EmptyState } from '../components/EmptyState.js';
import { OperationResultsModal, type OperationResult } from '../components/OperationResultsModal.js';

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
  const toast = useToast();
  const [services, setServices] = useState<ServiceWithServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('list');

  // Bulk deploy state
  const [bulkDeploying, setBulkDeploying] = useState(false);
  const [deployResults, setDeployResults] = useState<OperationResult[] | null>(null);
  const [showDeployResults, setShowDeployResults] = useState(false);

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
        <div className="flex items-center gap-6">
          <p className="text-slate-400">
            All services in {selectedEnvironment?.name}
          </p>
          {/* Tabs */}
          <div className="flex border border-slate-700 rounded-lg overflow-hidden">
            <button
              onClick={() => setActiveTab('list')}
              className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                activeTab === 'list'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              List
            </button>
            <button
              onClick={() => setActiveTab('dependencies')}
              className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                activeTab === 'dependencies'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              Dependencies
            </button>
          </div>
        </div>
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
      <div className="panel">
        {filteredServices.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                  <th className="pb-3 font-medium">Service</th>
                  <th className="pb-3 font-medium">Server</th>
                  <th className="pb-3 font-medium">Type</th>
                  <th className="pb-3 font-medium">Image</th>
                  <th className="pb-3 font-medium">Ports</th>
                  <th className="pb-3 font-medium">Container</th>
                  <th className="pb-3 font-medium">Health</th>
                  <th className="pb-3 font-medium">Last Checked</th>
                  <th className="pb-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {paginatedData.map((service) => {
                  const ports = parseExposedPorts(service.exposedPorts);
                  const hasUpdate = service.latestAvailableTag && service.latestAvailableTag !== service.imageTag;
                  const depNode = dependencyNodes.get(service.id);
                  const hasDependencies = depNode && (depNode.dependencyCount > 0 || depNode.dependentCount > 0);
                  const hasContainerImage = depNode?.containerImage;
                  return (
                    <tr key={service.id} className={`text-slate-300 ${hasUpdate ? 'bg-primary-900/10' : ''}`}>
                      <td className="py-4">
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/services/${service.id}`}
                            className="text-white hover:text-primary-400 font-medium"
                          >
                            {service.name}
                          </Link>
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
                        <p className="text-sm text-slate-400 font-mono">
                          {service.containerName}
                        </p>
                      </td>
                      <td className="py-4">
                        <Link
                          to={`/servers/${service.serverId}`}
                          className="text-slate-300 hover:text-primary-400"
                        >
                          {service.serverName}
                        </Link>
                      </td>
                      <td className="py-4 text-sm text-slate-400">
                        {service.serviceType?.displayName || 'Generic'}
                      </td>
                      <td className="py-4 font-mono text-sm">
                        <span className="text-slate-400">
                          {service.containerImage?.imageName?.split('/').pop() || 'unknown'}
                        </span>
                        :<span className="text-primary-400">{service.imageTag}</span>
                        {hasUpdate && (
                          <div className="flex items-center gap-1 mt-1">
                            <span className="text-xs text-slate-500">→</span>
                            <span className="text-xs text-green-400 font-mono">{service.latestAvailableTag}</span>
                          </div>
                        )}
                      </td>
                      <td className="py-4 font-mono text-sm text-slate-400">
                        {formatPorts(ports)}
                      </td>
                      <td className="py-4">
                        <span className={`badge ${getContainerStatusColor(service.containerStatus || service.status)}`}>
                          {service.containerStatus || service.status}
                        </span>
                      </td>
                      <td className="py-4">
                        <span className={`badge ${getHealthStatusColor(service.healthStatus || 'unknown')}`}>
                          {service.healthStatus || 'unknown'}
                        </span>
                      </td>
                      <td className="py-4 text-sm text-slate-400">
                        {service.lastCheckedAt
                          ? formatDistanceToNow(new Date(service.lastCheckedAt), {
                              addSuffix: true,
                            })
                          : 'Never'}
                      </td>
                      <td className="py-4 text-right">
                        <Link
                          to={`/services/${service.id}`}
                          className="text-primary-400 hover:text-primary-300 text-sm"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={totalItems}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </div>
        ) : (
          <EmptyState
            message="No services discovered"
            description="Go to a server and click 'Discover Containers' to find services"
          />
        )}
      </div>
      )}
    </div>
  );
}

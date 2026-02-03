import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { getEnvironment, deployService, getDependencyGraph, type Service, type ExposedPort, type DependencyGraphNode } from '../lib/api';
import { formatDistanceToNow } from 'date-fns';
import { getContainerStatusColor, getHealthStatusColor } from '../lib/status';
import { Modal } from '../components/Modal';
import { CheckIcon, WarningIcon, RefreshIcon } from '../components/Icons';
import { useToast } from '../components/Toast';
import Pagination from '../components/Pagination';
import { usePagination } from '../hooks/usePagination';

interface ServiceWithServer extends Service {
  serverName: string;
}

interface DeployResult {
  serviceId: string;
  serviceName: string;
  serverName: string;
  imageTag: string;
  success: boolean;
  error?: string;
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

export default function Services() {
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const [services, setServices] = useState<ServiceWithServer[]>([]);
  const [loading, setLoading] = useState(true);

  // Filter state
  const [showUpdatesOnly, setShowUpdatesOnly] = useState(false);

  // Bulk deploy state
  const [bulkDeploying, setBulkDeploying] = useState(false);
  const [deployResults, setDeployResults] = useState<DeployResult[] | null>(null);
  const [showDeployResults, setShowDeployResults] = useState(false);

  // Dependency graph nodes for indicators
  const [dependencyNodes, setDependencyNodes] = useState<Map<string, DependencyGraphNode>>(new Map());

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

          // Build map of dependency nodes
          const nodeMap = new Map<string, DependencyGraphNode>();
          graph.nodes.forEach((node) => nodeMap.set(node.id, node));
          setDependencyNodes(nodeMap);
        })
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id]);

  // Services with available updates
  const servicesWithUpdates = services.filter(
    (s) => s.latestAvailableTag && s.latestAvailableTag !== s.imageTag
  );

  // Filtered services based on "show updates only" toggle
  const filteredServices = showUpdatesOnly ? servicesWithUpdates : services;

  const handleBulkDeployAll = async () => {
    if (servicesWithUpdates.length === 0) return;

    setBulkDeploying(true);
    setDeployResults(null);
    setShowDeployResults(true);

    const results: DeployResult[] = [];

    for (const service of servicesWithUpdates) {
      try {
        await deployService(service.id, {
          imageTag: service.latestAvailableTag!,
          pullImage: true,
        });
        results.push({
          serviceId: service.id,
          serviceName: service.name,
          serverName: service.serverName,
          imageTag: service.latestAvailableTag!,
          success: true,
        });
      } catch (err) {
        results.push({
          serviceId: service.id,
          serviceName: service.name,
          serverName: service.serverName,
          imageTag: service.latestAvailableTag!,
          success: false,
          error: err instanceof Error ? err.message : 'Deploy failed',
        });
      }
      // Update results as we go
      setDeployResults([...results]);
    }

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
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-7 w-32 bg-slate-700 rounded mb-5"></div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 bg-slate-800 rounded-lg"></div>
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
          All services in {selectedEnvironment?.name}
        </p>
        <div className="flex items-center gap-4">
          {servicesWithUpdates.length > 0 && (
            <>
              <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showUpdatesOnly}
                  onChange={(e) => setShowUpdatesOnly(e.target.checked)}
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
      <Modal
        isOpen={showDeployResults}
        onClose={() => {
          setShowDeployResults(false);
          setDeployResults(null);
        }}
        title="Bulk Deploy"
        size="md"
      >
        {deployResults === null ? (
          <div className="flex flex-col items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500 mb-4"></div>
            <p className="text-slate-400">Deploying {servicesWithUpdates.length} services...</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <div className={`p-3 rounded-lg ${
              deployResults.every(r => r.success)
                ? 'bg-green-500/10 border border-green-500/30'
                : deployResults.some(r => r.success)
                ? 'bg-yellow-500/10 border border-yellow-500/30'
                : 'bg-red-500/10 border border-red-500/30'
            }`}>
              <div className="flex items-center gap-2">
                {deployResults.every(r => r.success) ? (
                  <CheckIcon className="w-5 h-5 text-green-400" />
                ) : (
                  <WarningIcon className="w-5 h-5 text-yellow-400" />
                )}
                <span className={
                  deployResults.every(r => r.success) ? 'text-green-400' :
                  deployResults.some(r => r.success) ? 'text-yellow-400' : 'text-red-400'
                }>
                  {deployResults.filter(r => r.success).length} of {deployResults.length} deployed successfully
                </span>
              </div>
            </div>

            {/* Results List */}
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {deployResults.map((result) => (
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
                  setShowDeployResults(false);
                  setDeployResults(null);
                }}
                className="btn btn-primary"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </Modal>

      <div className="panel">
        {filteredServices.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                  <th className="pb-3 font-medium">Service</th>
                  <th className="pb-3 font-medium">Server</th>
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
          <div className="text-center py-12">
            <p className="text-slate-400">No services discovered</p>
            <p className="text-sm text-slate-500 mt-2">
              Go to a server and click "Discover Containers" to find services
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  getServer,
  checkServerHealth,
  discoverContainers,
  deleteService,
  createService,
  getAgentStatus,
  getServerMetrics,
  collectServerMetrics,
  updateServerMetricsMode,
  regenerateAgentToken,
  deployAgent,
  removeAgent,
  updateServer,
  deleteServer,
  type ServerWithServices,
  type MetricsMode,
  type ServerMetrics,
  type CreateServiceInput,
  type UpdateServerInput,
  type ExposedPort,
} from '../lib/api';
import { useToast } from '../components/Toast';
import { formatDistanceToNow } from 'date-fns';

function parseExposedPorts(portsJson: string | null): ExposedPort[] {
  if (!portsJson) return [];
  try {
    return JSON.parse(portsJson);
  } catch {
    return [];
  }
}

function formatPorts(ports: ExposedPort[], maxDisplay = 3): string {
  if (ports.length === 0) return '-';
  const displayed = ports.slice(0, maxDisplay).map(p =>
    p.host ? `${p.host}:${p.container}` : `${p.container}`
  );
  if (ports.length > maxDisplay) {
    displayed.push(`+${ports.length - maxDisplay}`);
  }
  return displayed.join(', ');
}

function getContainerStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'badge-success';
    case 'stopped':
    case 'exited':
    case 'dead':
      return 'badge-error';
    case 'restarting':
    case 'paused':
    case 'created':
      return 'badge-warning';
    default:
      return 'badge-warning';
  }
}

function getHealthStatusColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'badge-success';
    case 'unhealthy':
      return 'badge-error';
    case 'none':
      return 'bg-slate-600 text-slate-300';
    default:
      return 'badge-warning';
  }
}

interface AgentStatus {
  metricsMode: string;
  hasToken: boolean;
  installed: boolean;
  running: boolean;
  error?: string;
}

export default function ServerDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [server, setServer] = useState<ServerWithServices | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Monitoring state
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [latestMetrics, setLatestMetrics] = useState<ServerMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [modeChanging, setModeChanging] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [agentToken, setAgentToken] = useState<string | null>(null);

  // Create service modal state
  const [showCreateService, setShowCreateService] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newService, setNewService] = useState<CreateServiceInput>({
    name: '',
    containerName: '',
    imageName: '',
    imageTag: 'latest',
    composePath: '',
    healthCheckUrl: '',
  });

  // Edit server modal state
  const navigate = useNavigate();
  const [showEditServer, setShowEditServer] = useState(false);
  const [editingServer, setEditingServer] = useState(false);
  const [editServerError, setEditServerError] = useState<string | null>(null);
  const [editServerData, setEditServerData] = useState<UpdateServerInput>({
    name: '',
    hostname: '',
    publicIp: '',
    tags: [],
  });
  const [editTagInput, setEditTagInput] = useState('');

  useEffect(() => {
    if (id) {
      setLoading(true);
      Promise.all([
        getServer(id),
        getAgentStatus(id),
        getServerMetrics(id, undefined, undefined, 1),
      ])
        .then(([serverRes, statusRes, metricsRes]) => {
          setServer(serverRes.server);
          setAgentStatus(statusRes);
          if (metricsRes.metrics.length > 0) {
            setLatestMetrics(metricsRes.metrics[0]);
          }
        })
        .finally(() => setLoading(false));
    }
  }, [id]);

  const handleHealthCheck = async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      const result = await checkServerHealth(id);
      setServer((prev) =>
        prev
          ? { ...prev, status: result.status, lastCheckedAt: new Date().toISOString() }
          : null
      );
    } finally {
      setActionLoading(false);
    }
  };

  const handleDiscover = async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      const { services } = await discoverContainers(id);
      setServer((prev) => (prev ? { ...prev, services } : null));
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteService = async (serviceId: string, serviceName: string) => {
    if (!confirm(`Delete service "${serviceName}"? This cannot be undone.`)) return;
    try {
      await deleteService(serviceId);
      setServer((prev) =>
        prev ? { ...prev, services: prev.services.filter(s => s.id !== serviceId) } : null
      );
      toast.success('Service deleted');
    } catch (error) {
      toast.error('Failed to delete service');
    }
  };

  const handleModeChange = async (mode: MetricsMode) => {
    if (!id || modeChanging) return;
    setModeChanging(true);
    try {
      const result = await updateServerMetricsMode(id, mode);
      setAgentStatus((prev) => prev ? { ...prev, metricsMode: mode } : null);
      if (result.server.agentToken) {
        setAgentToken(result.server.agentToken);
      }
      // Refresh agent status after mode change
      const statusRes = await getAgentStatus(id);
      setAgentStatus(statusRes);
      toast.success(`Metrics mode changed to ${mode}`);
    } catch (error) {
      toast.error('Failed to change metrics mode');
    } finally {
      setModeChanging(false);
    }
  };

  const handleCollectMetrics = async () => {
    if (!id) return;
    setMetricsLoading(true);
    try {
      await collectServerMetrics(id);
      // Refresh metrics after collection
      const metricsRes = await getServerMetrics(id, undefined, undefined, 1);
      if (metricsRes.metrics.length > 0) {
        setLatestMetrics(metricsRes.metrics[0]);
      }
      toast.success('Metrics collected');
    } catch (error) {
      toast.error('Failed to collect metrics');
    } finally {
      setMetricsLoading(false);
    }
  };

  const handleRegenerateToken = async () => {
    if (!id) return;
    if (!confirm('Regenerate agent token? The existing agent will need to be redeployed.')) return;
    try {
      const result = await regenerateAgentToken(id);
      setAgentToken(result.agentToken);
      toast.success('Token regenerated');
    } catch (error) {
      toast.error('Failed to regenerate token');
    }
  };

  const handleDeployAgent = async () => {
    if (!id) return;
    setModeChanging(true);
    try {
      await deployAgent(id);
      const statusRes = await getAgentStatus(id);
      setAgentStatus(statusRes);
      toast.success('Agent deployed');
    } catch (error) {
      toast.error('Failed to deploy agent');
    } finally {
      setModeChanging(false);
    }
  };

  const handleRemoveAgent = async () => {
    if (!id) return;
    if (!confirm('Remove the monitoring agent from this server?')) return;
    setModeChanging(true);
    try {
      await removeAgent(id);
      const statusRes = await getAgentStatus(id);
      setAgentStatus(statusRes);
      toast.success('Agent removed');
    } catch (error) {
      toast.error('Failed to remove agent');
    } finally {
      setModeChanging(false);
    }
  };

  const copyToken = () => {
    if (agentToken) {
      navigator.clipboard.writeText(agentToken);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    }
  };

  const handleCreateService = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { service } = await createService(id, {
        ...newService,
        composePath: newService.composePath || undefined,
        healthCheckUrl: newService.healthCheckUrl || undefined,
      });
      setServer((prev) => prev ? { ...prev, services: [...prev.services, service] } : null);
      setShowCreateService(false);
      setNewService({
        name: '',
        containerName: '',
        imageName: '',
        imageTag: 'latest',
        composePath: '',
        healthCheckUrl: '',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create service';
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  };

  const openEditServer = () => {
    if (!server) return;
    setEditServerData({
      name: server.name,
      hostname: server.hostname,
      publicIp: server.publicIp || '',
      tags: server.tags ? JSON.parse(server.tags) : [],
    });
    setEditTagInput('');
    setEditServerError(null);
    setShowEditServer(true);
  };

  const handleEditServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setEditingServer(true);
    setEditServerError(null);
    try {
      const { server: updatedServer } = await updateServer(id, {
        name: editServerData.name,
        hostname: editServerData.hostname,
        publicIp: editServerData.publicIp || null,
        tags: editServerData.tags,
      });
      setServer((prev) => prev ? { ...prev, ...updatedServer } : null);
      setShowEditServer(false);
      toast.success('Server updated');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update server';
      setEditServerError(message);
    } finally {
      setEditingServer(false);
    }
  };

  const handleDeleteServer = async () => {
    if (!id || !server) return;
    if (!confirm(`Delete server "${server.name}"? This will also delete all services on this server. This cannot be undone.`)) return;
    try {
      await deleteServer(id);
      toast.success('Server deleted');
      navigate('/servers');
    } catch (error) {
      toast.error('Failed to delete server');
    }
  };

  const addEditTag = () => {
    if (editTagInput.trim() && !editServerData.tags?.includes(editTagInput.trim())) {
      setEditServerData((prev) => ({
        ...prev,
        tags: [...(prev.tags || []), editTagInput.trim()],
      }));
      setEditTagInput('');
    }
  };

  const removeEditTag = (tag: string) => {
    setEditServerData((prev) => ({
      ...prev,
      tags: (prev.tags || []).filter((t) => t !== tag),
    }));
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-8"></div>
          <div className="h-64 bg-slate-800 rounded-xl"></div>
        </div>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="p-8">
        <div className="card text-center py-12">
          <p className="text-slate-400">Server not found</p>
          <Link to="/servers" className="btn btn-primary mt-4">
            Back to Servers
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="flex items-center gap-3">
            <div
              className={`w-3 h-3 rounded-full ${
                server.status === 'healthy'
                  ? 'bg-green-500'
                  : server.status === 'unhealthy'
                  ? 'bg-red-500'
                  : 'bg-yellow-500'
              }`}
            />
            <h1 className="text-2xl font-bold text-white">{server.name}</h1>
          </div>
          <p className="text-slate-400 mt-1">
            {server.hostname}
            {server.publicIp && ` • Public: ${server.publicIp}`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={openEditServer}
            className="btn btn-ghost"
            title="Edit Server"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button
            onClick={() => setShowCreateService(true)}
            className="btn btn-ghost"
          >
            Create Service
          </button>
          <button
            onClick={handleDiscover}
            disabled={actionLoading}
            className="btn btn-secondary"
          >
            {actionLoading ? 'Loading...' : 'Discover Containers'}
          </button>
          <button
            onClick={handleHealthCheck}
            disabled={actionLoading}
            className="btn btn-primary"
          >
            {actionLoading ? 'Checking...' : 'Health Check'}
          </button>
        </div>
      </div>

      {/* Server Info */}
      <div className="grid grid-cols-2 gap-6 mb-8">
        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Details</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-slate-400">Status</dt>
              <dd>
                <span
                  className={`badge ${
                    server.status === 'healthy'
                      ? 'badge-success'
                      : server.status === 'unhealthy'
                      ? 'badge-error'
                      : 'badge-warning'
                  }`}
                >
                  {server.status}
                </span>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Private IP</dt>
              <dd className="font-mono text-white">{server.hostname}</dd>
            </div>
            {server.publicIp && (
              <div className="flex justify-between">
                <dt className="text-slate-400">Public IP</dt>
                <dd className="font-mono text-white">{server.publicIp}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-slate-400">Last Checked</dt>
              <dd className="text-white">
                {server.lastCheckedAt
                  ? formatDistanceToNow(new Date(server.lastCheckedAt), {
                      addSuffix: true,
                    })
                  : 'Never'}
              </dd>
            </div>
          </dl>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Tags</h3>
          <div className="flex flex-wrap gap-2">
            {server.tags &&
              JSON.parse(server.tags).map((tag: string) => (
                <span
                  key={tag}
                  className="px-3 py-1 bg-slate-700 rounded-full text-sm text-slate-300"
                >
                  {tag}
                </span>
              ))}
            {(!server.tags || JSON.parse(server.tags).length === 0) && (
              <p className="text-slate-400">No tags</p>
            )}
          </div>
        </div>
      </div>

      {/* Monitoring Card */}
      <div className="card mb-8">
        <h3 className="text-lg font-semibold text-white mb-4">Monitoring</h3>

        {/* Mode Selection */}
        <div className="mb-6">
          <label className="text-sm text-slate-400 mb-2 block">Mode</label>
          <div className="flex gap-4">
            {(['disabled', 'ssh', 'agent'] as const).map((mode) => (
              <label
                key={mode}
                className={`flex items-center gap-2 cursor-pointer ${
                  modeChanging ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                <input
                  type="radio"
                  name="metricsMode"
                  value={mode}
                  checked={agentStatus?.metricsMode === mode}
                  onChange={() => handleModeChange(mode)}
                  disabled={modeChanging}
                  className="w-4 h-4 text-primary-600 bg-slate-700 border-slate-600"
                />
                <span className="text-white capitalize">{mode === 'ssh' ? 'SSH' : mode}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Mode-specific content */}
        {agentStatus?.metricsMode === 'ssh' && (
          <div className="mb-6 p-4 bg-slate-800 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Status</p>
                <p className="text-white">
                  {latestMetrics
                    ? `Last collected ${formatDistanceToNow(new Date(latestMetrics.collectedAt), { addSuffix: true })}`
                    : 'No metrics collected yet'}
                </p>
              </div>
              <button
                onClick={handleCollectMetrics}
                disabled={metricsLoading}
                className="btn btn-secondary"
              >
                {metricsLoading ? 'Collecting...' : 'Collect Now'}
              </button>
            </div>
          </div>
        )}

        {agentStatus?.metricsMode === 'agent' && (
          <div className="mb-6 p-4 bg-slate-800 rounded-lg space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Agent Status</p>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      agentStatus.running
                        ? 'bg-green-500'
                        : agentStatus.installed
                        ? 'bg-yellow-500'
                        : 'bg-slate-500'
                    }`}
                  />
                  <span className="text-white">
                    {agentStatus.running
                      ? 'Running'
                      : agentStatus.installed
                      ? 'Installed but not running'
                      : 'Not installed'}
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                {agentStatus.installed ? (
                  <button
                    onClick={handleRemoveAgent}
                    disabled={modeChanging}
                    className="btn btn-secondary text-red-400"
                  >
                    Remove Agent
                  </button>
                ) : (
                  <button
                    onClick={handleDeployAgent}
                    disabled={modeChanging}
                    className="btn btn-primary"
                  >
                    {modeChanging ? 'Deploying...' : 'Deploy Agent'}
                  </button>
                )}
              </div>
            </div>

            {agentStatus.hasToken && (
              <div>
                <p className="text-slate-400 text-sm mb-2">Agent Token</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-slate-900 rounded text-sm text-slate-300 font-mono">
                    {agentToken ? agentToken : '••••••••••••••••'}
                  </code>
                  {agentToken && (
                    <button onClick={copyToken} className="btn btn-secondary text-sm">
                      {tokenCopied ? 'Copied!' : 'Copy'}
                    </button>
                  )}
                  <button onClick={handleRegenerateToken} className="btn btn-secondary text-sm">
                    Regenerate
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Recent Metrics */}
        {latestMetrics && agentStatus?.metricsMode !== 'disabled' && (
          <div>
            <p className="text-slate-400 text-sm mb-3">Recent Metrics</p>
            <div className="grid grid-cols-4 gap-4">
              {/* CPU */}
              <div className="p-3 bg-slate-800 rounded-lg">
                <p className="text-slate-400 text-xs mb-1">CPU</p>
                <p className="text-xl font-semibold text-white">
                  {latestMetrics.cpuPercent?.toFixed(1) ?? '-'}%
                </p>
                <div className="h-1 mt-2 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary-500 rounded-full"
                    style={{ width: `${Math.min(latestMetrics.cpuPercent || 0, 100)}%` }}
                  />
                </div>
              </div>

              {/* Memory */}
              <div className="p-3 bg-slate-800 rounded-lg">
                <p className="text-slate-400 text-xs mb-1">Memory</p>
                <p className="text-xl font-semibold text-white">
                  {latestMetrics.memoryUsedMb
                    ? `${(latestMetrics.memoryUsedMb / 1024).toFixed(1)}`
                    : '-'}
                  <span className="text-sm text-slate-400">
                    /{latestMetrics.memoryTotalMb ? (latestMetrics.memoryTotalMb / 1024).toFixed(0) : '-'}GB
                  </span>
                </p>
                {latestMetrics.memoryTotalMb && (
                  <div className="h-1 mt-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-500 rounded-full"
                      style={{
                        width: `${Math.min(
                          ((latestMetrics.memoryUsedMb || 0) / latestMetrics.memoryTotalMb) * 100,
                          100
                        )}%`,
                      }}
                    />
                  </div>
                )}
              </div>

              {/* Disk */}
              <div className="p-3 bg-slate-800 rounded-lg">
                <p className="text-slate-400 text-xs mb-1">Disk</p>
                <p className="text-xl font-semibold text-white">
                  {latestMetrics.diskUsedGb?.toFixed(0) ?? '-'}
                  <span className="text-sm text-slate-400">
                    /{latestMetrics.diskTotalGb?.toFixed(0) ?? '-'}GB
                  </span>
                </p>
                {latestMetrics.diskTotalGb && (
                  <div className="h-1 mt-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-yellow-500 rounded-full"
                      style={{
                        width: `${Math.min(
                          ((latestMetrics.diskUsedGb || 0) / latestMetrics.diskTotalGb) * 100,
                          100
                        )}%`,
                      }}
                    />
                  </div>
                )}
              </div>

              {/* Load */}
              <div className="p-3 bg-slate-800 rounded-lg">
                <p className="text-slate-400 text-xs mb-1">Load Avg</p>
                <p className="text-xl font-semibold text-white font-mono">
                  {latestMetrics.loadAvg1?.toFixed(2) ?? '-'}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {latestMetrics.loadAvg5?.toFixed(2)} / {latestMetrics.loadAvg15?.toFixed(2)}
                </p>
              </div>
            </div>
          </div>
        )}

        {!latestMetrics && agentStatus?.metricsMode !== 'disabled' && (
          <p className="text-slate-400 text-sm">
            No metrics available.{' '}
            {agentStatus?.metricsMode === 'ssh' && 'Click "Collect Now" to gather metrics.'}
            {agentStatus?.metricsMode === 'agent' && !agentStatus.installed && 'Deploy the agent to start collecting metrics.'}
          </p>
        )}
      </div>

      {/* Active Services */}
      {(() => {
        const activeServices = server.services.filter(s => s.discoveryStatus !== 'missing');
        const missingServices = server.services.filter(s => s.discoveryStatus === 'missing');

        return (
          <>
            <div className="card mb-6">
              <h3 className="text-lg font-semibold text-white mb-4">
                Services ({activeServices.length})
              </h3>
              {activeServices.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                        <th className="pb-3 font-medium">Name</th>
                        <th className="pb-3 font-medium">Container</th>
                        <th className="pb-3 font-medium">Image</th>
                        <th className="pb-3 font-medium">Ports</th>
                        <th className="pb-3 font-medium">Container</th>
                        <th className="pb-3 font-medium">Health</th>
                        <th className="pb-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                      {activeServices.map((service) => {
                        const ports = parseExposedPorts(service.exposedPorts);
                        return (
                          <tr key={service.id} className="text-slate-300">
                            <td className="py-3">
                              <Link
                                to={`/services/${service.id}`}
                                className="text-white hover:text-primary-400"
                              >
                                {service.name}
                              </Link>
                            </td>
                            <td className="py-3 font-mono text-sm">
                              {service.containerName}
                            </td>
                            <td className="py-3 font-mono text-sm">
                              {service.imageName.split('/').pop()}:{service.imageTag}
                            </td>
                            <td className="py-3 font-mono text-sm text-slate-400">
                              {formatPorts(ports)}
                            </td>
                            <td className="py-3">
                              <span className={`badge ${getContainerStatusColor(service.containerStatus || service.status)}`}>
                                {service.containerStatus || service.status}
                              </span>
                            </td>
                            <td className="py-3">
                              <span className={`badge ${getHealthStatusColor(service.healthStatus || 'unknown')}`}>
                                {service.healthStatus || 'unknown'}
                              </span>
                            </td>
                            <td className="py-3 text-right">
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
                </div>
              ) : (
                <p className="text-slate-400">
                  No services discovered. Click "Discover Containers" to scan for Docker containers.
                </p>
              )}
            </div>

            {/* Missing Services */}
            {missingServices.length > 0 && (
              <div className="card border-orange-500/30">
                <h3 className="text-lg font-semibold text-orange-400 mb-4">
                  Missing Services ({missingServices.length})
                </h3>
                <p className="text-slate-400 text-sm mb-4">
                  These services were previously discovered but are no longer running on the server.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                        <th className="pb-3 font-medium">Name</th>
                        <th className="pb-3 font-medium">Container</th>
                        <th className="pb-3 font-medium">Image</th>
                        <th className="pb-3 font-medium">Status</th>
                        <th className="pb-3 font-medium">Last Seen</th>
                        <th className="pb-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                      {missingServices.map((service) => (
                        <tr key={service.id} className="text-slate-400">
                          <td className="py-3">
                            <Link
                              to={`/services/${service.id}`}
                              className="text-slate-300 hover:text-primary-400"
                            >
                              {service.name}
                            </Link>
                          </td>
                          <td className="py-3 font-mono text-sm">
                            {service.containerName}
                          </td>
                          <td className="py-3 font-mono text-sm">
                            {service.imageName.split('/').pop()}:{service.imageTag}
                          </td>
                          <td className="py-3">
                            <span className={`badge ${getContainerStatusColor(service.containerStatus || 'not_found')}`}>
                              {service.containerStatus || 'not_found'}
                            </span>
                          </td>
                          <td className="py-3">
                            {service.lastDiscoveredAt
                              ? formatDistanceToNow(new Date(service.lastDiscoveredAt), {
                                  addSuffix: true,
                                })
                              : 'Unknown'}
                          </td>
                          <td className="py-3 text-right space-x-3">
                            <Link
                              to={`/services/${service.id}`}
                              className="text-primary-400 hover:text-primary-300 text-sm"
                            >
                              View
                            </Link>
                            <button
                              onClick={() => handleDeleteService(service.id, service.name)}
                              className="text-red-400 hover:text-red-300 text-sm"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* Create Service Modal */}
      {showCreateService && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Create Service</h3>
            <form onSubmit={handleCreateService} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Service Name *</label>
                <input
                  type="text"
                  value={newService.name}
                  onChange={(e) => setNewService({ ...newService, name: e.target.value })}
                  placeholder="e.g., app-api"
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Container Name *</label>
                <input
                  type="text"
                  value={newService.containerName}
                  onChange={(e) => setNewService({ ...newService, containerName: e.target.value })}
                  placeholder="e.g., app-api-container"
                  className="input font-mono text-sm"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">Docker container name to manage</p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Image Name *</label>
                <input
                  type="text"
                  value={newService.imageName}
                  onChange={(e) => setNewService({ ...newService, imageName: e.target.value })}
                  placeholder="e.g., registry.digitalocean.com/my-registry/app-api"
                  className="input font-mono text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Image Tag</label>
                <input
                  type="text"
                  value={newService.imageTag}
                  onChange={(e) => setNewService({ ...newService, imageTag: e.target.value })}
                  placeholder="latest"
                  className="input font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Compose Path</label>
                <input
                  type="text"
                  value={newService.composePath}
                  onChange={(e) => setNewService({ ...newService, composePath: e.target.value })}
                  placeholder="/opt/app/docker-compose.yml"
                  className="input font-mono text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">Path to docker-compose.yml on server</p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Health Check URL</label>
                <input
                  type="text"
                  value={newService.healthCheckUrl}
                  onChange={(e) => setNewService({ ...newService, healthCheckUrl: e.target.value })}
                  placeholder="http://localhost:8000/health"
                  className="input font-mono text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">URL to check during health checks (from the server)</p>
              </div>

              {createError && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                  {createError}
                </div>
              )}

              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateService(false);
                    setCreateError(null);
                  }}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={creating} className="btn btn-primary">
                  {creating ? 'Creating...' : 'Create Service'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Server Modal */}
      {showEditServer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Edit Server</h3>
            <form onSubmit={handleEditServer} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Server Name *</label>
                <input
                  type="text"
                  value={editServerData.name}
                  onChange={(e) => setEditServerData({ ...editServerData, name: e.target.value })}
                  placeholder="e.g., app-api-staging"
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Hostname / Private IP *</label>
                <input
                  type="text"
                  value={editServerData.hostname}
                  onChange={(e) => setEditServerData({ ...editServerData, hostname: e.target.value })}
                  placeholder="e.g., 10.20.10.3"
                  className="input font-mono text-sm"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">IP or hostname used to connect via SSH</p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Public IP</label>
                <input
                  type="text"
                  value={editServerData.publicIp || ''}
                  onChange={(e) => setEditServerData({ ...editServerData, publicIp: e.target.value })}
                  placeholder="e.g., 123.45.67.89"
                  className="input font-mono text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">Public-facing IP address (optional)</p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Tags</label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {(editServerData.tags || []).map((tag) => (
                    <span
                      key={tag}
                      className="px-2 py-1 bg-slate-700 rounded text-sm text-slate-300 flex items-center gap-1"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => removeEditTag(tag)}
                        className="text-slate-400 hover:text-white"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={editTagInput}
                    onChange={(e) => setEditTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addEditTag();
                      }
                    }}
                    placeholder="Add tag..."
                    className="input flex-1"
                  />
                  <button type="button" onClick={addEditTag} className="btn btn-secondary">
                    Add
                  </button>
                </div>
              </div>

              {editServerError && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                  {editServerError}
                </div>
              )}

              <div className="flex gap-2 justify-between pt-2">
                <button
                  type="button"
                  onClick={handleDeleteServer}
                  className="btn btn-ghost text-red-400 hover:text-red-300"
                >
                  Delete Server
                </button>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowEditServer(false);
                      setEditServerError(null);
                    }}
                    className="btn btn-ghost"
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={editingServer} className="btn btn-primary">
                    {editingServer ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

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
  getServerProcesses,
  collectServerMetrics,
  updateServerMetricsMode,
  regenerateAgentToken,
  deployAgent,
  removeAgent,
  updateServer,
  deleteServer,
  getServerConfigFilesStatus,
  syncAllServerFiles,
  listContainerImages,
  type ServerWithServices,
  type MetricsMode,
  type ServerMetrics,
  type CreateServiceInput,
  type UpdateServerInput,
  type ExposedPort,
  type ServerConfigFileStatus,
  type ServerConfigFilesSyncTotals,
  type ServerSyncAllResult,
  type ContainerImage,
  type ProcessSnapshot,
} from '../lib/api';
import { useToast } from '../components/Toast';
import { formatDistanceToNow } from 'date-fns';
import { getContainerStatusColor, getHealthStatusColor, getSyncStatusColor } from '../lib/status';
import { Modal } from '../components/Modal';
import { RefreshIcon, CheckIcon, WarningIcon, FileIcon } from '../components/Icons';

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

type AgentStatusType = 'unknown' | 'deploying' | 'waiting' | 'active' | 'stale' | 'offline';

interface AgentStatus {
  metricsMode: string;
  hasToken: boolean;
  agentStatus: AgentStatusType;
  agentVersion: string | null;
  lastAgentPushAt: string | null;
  installed: boolean;
  running: boolean;
  error?: string;
}

function getAgentStatusBadge(status: AgentStatusType) {
  switch (status) {
    case 'active':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400">Active</span>;
    case 'deploying':
      return (
        <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400 animate-pulse">
          Deploying...
        </span>
      );
    case 'waiting':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-500/20 text-yellow-400">Waiting for first push</span>;
    case 'stale':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-orange-500/20 text-orange-400">Stale</span>;
    case 'offline':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400">Offline</span>;
    default:
      return <span className="px-2 py-0.5 text-xs rounded-full bg-slate-500/20 text-slate-400">Unknown</span>;
  }
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
  const [containerImages, setContainerImages] = useState<ContainerImage[]>([]);
  const [newService, setNewService] = useState<CreateServiceInput>({
    name: '',
    containerName: '',
    containerImageId: '',
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

  // Config files sync status
  const [configFilesStatus, setConfigFilesStatus] = useState<ServerConfigFileStatus[]>([]);
  const [configFilesTotals, setConfigFilesTotals] = useState<ServerConfigFilesSyncTotals | null>(null);
  const [loadingConfigFiles, setLoadingConfigFiles] = useState(false);
  const [syncingAllFiles, setSyncingAllFiles] = useState(false);
  const [syncResults, setSyncResults] = useState<ServerSyncAllResult[] | null>(null);
  const [showSyncResults, setShowSyncResults] = useState(false);

  // Process snapshot (from agent)
  const [processSnapshot, setProcessSnapshot] = useState<ProcessSnapshot | null>(null);
  const [processUpdatedAt, setProcessUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    if (id) {
      setLoading(true);
      Promise.all([
        getServer(id),
        getAgentStatus(id),
        getServerMetrics(id, undefined, undefined, 1),
        getServerProcesses(id),
      ])
        .then(([serverRes, statusRes, metricsRes, processRes]) => {
          setServer(serverRes.server);
          setAgentStatus(statusRes);
          if (metricsRes.metrics.length > 0) {
            setLatestMetrics(metricsRes.metrics[0]);
          }
          if (processRes.hasData && processRes.processes) {
            setProcessSnapshot(processRes.processes);
            setProcessUpdatedAt(processRes.updatedAt);
          }
          // Load container images for the server's environment
          if (serverRes.server.environmentId) {
            listContainerImages(serverRes.server.environmentId)
              .then(({ images }) => setContainerImages(images))
              .catch(() => setContainerImages([]));
          }
        })
        .finally(() => setLoading(false));

      // Load config files sync status
      loadConfigFilesStatus(id);
    }
  }, [id]);

  const loadConfigFilesStatus = async (serverId: string) => {
    setLoadingConfigFiles(true);
    try {
      const result = await getServerConfigFilesStatus(serverId);
      setConfigFilesStatus(result.configFiles);
      setConfigFilesTotals(result.totals);
    } catch {
      // Ignore errors - config files section is optional
    } finally {
      setLoadingConfigFiles(false);
    }
  };

  const handleSyncAllFiles = async () => {
    if (!id) return;
    setSyncingAllFiles(true);
    setSyncResults(null);
    setShowSyncResults(true);
    try {
      const result = await syncAllServerFiles(id);
      setSyncResults(result.results);
      // Reload config files status
      await loadConfigFilesStatus(id);
      if (result.success) {
        toast.success('All files synced successfully');
      } else {
        toast.error('Some files failed to sync');
      }
    } catch (err) {
      setSyncResults([{
        configFileName: '',
        serviceName: '',
        targetPath: '',
        success: false,
        error: err instanceof Error ? err.message : 'Sync failed',
      }]);
      toast.error('Failed to sync files');
    } finally {
      setSyncingAllFiles(false);
    }
  };

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
        containerImageId: '',
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
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-5"></div>
          <div className="h-64 bg-slate-800 rounded-lg"></div>
        </div>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-slate-400">Server not found</p>
          <Link to="/servers" className="btn btn-primary mt-4">
            Back to Servers
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
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
            <h1 className="text-xl font-bold text-white">{server.name}</h1>
            {server.serverType === 'host' && (
              <span className="px-2 py-0.5 bg-purple-500/20 text-purple-400 text-sm font-medium rounded">
                Host Server
              </span>
            )}
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
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="panel">
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

        <div className="panel">
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
      <div className="panel mb-6">
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
                <div className="flex items-center gap-3 mt-1">
                  {getAgentStatusBadge(agentStatus.agentStatus)}
                  {agentStatus.agentVersion && (
                    <span className="text-slate-500 text-sm">
                      v{agentStatus.agentVersion}
                    </span>
                  )}
                  {agentStatus.lastAgentPushAt && (
                    <span className="text-slate-500 text-sm">
                      Last push: {formatDistanceToNow(new Date(agentStatus.lastAgentPushAt), { addSuffix: true })}
                    </span>
                  )}
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
            {/* Primary metrics row */}
            <div className="grid grid-cols-4 gap-4 mb-4">
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

            {/* Secondary metrics row (swap, FDs, TCP, uptime) */}
            <div className="grid grid-cols-4 gap-4">
              {/* Swap */}
              <div className="p-3 bg-slate-800 rounded-lg">
                <p className="text-slate-400 text-xs mb-1">Swap</p>
                {latestMetrics.swapTotalMb && latestMetrics.swapTotalMb > 0 ? (
                  <>
                    <p className="text-xl font-semibold text-white">
                      {((latestMetrics.swapUsedMb || 0) / 1024).toFixed(1)}
                      <span className="text-sm text-slate-400">
                        /{(latestMetrics.swapTotalMb / 1024).toFixed(0)}GB
                      </span>
                    </p>
                    <div className="h-1 mt-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-purple-500 rounded-full"
                        style={{
                          width: `${Math.min(
                            ((latestMetrics.swapUsedMb || 0) / latestMetrics.swapTotalMb) * 100,
                            100
                          )}%`,
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-slate-500 text-sm">No swap</p>
                )}
              </div>

              {/* File Descriptors */}
              <div className="p-3 bg-slate-800 rounded-lg">
                <p className="text-slate-400 text-xs mb-1">File Descriptors</p>
                {latestMetrics.openFds != null && latestMetrics.maxFds ? (
                  <>
                    <p className="text-xl font-semibold text-white">
                      {(latestMetrics.openFds / 1000).toFixed(1)}k
                      <span className="text-sm text-slate-400">
                        /{(latestMetrics.maxFds / 1000).toFixed(0)}k
                      </span>
                    </p>
                    <div className="h-1 mt-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          (latestMetrics.openFds / latestMetrics.maxFds) > 0.8
                            ? 'bg-red-500'
                            : (latestMetrics.openFds / latestMetrics.maxFds) > 0.6
                            ? 'bg-yellow-500'
                            : 'bg-green-500'
                        }`}
                        style={{
                          width: `${Math.min(
                            (latestMetrics.openFds / latestMetrics.maxFds) * 100,
                            100
                          )}%`,
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-slate-500 text-sm">-</p>
                )}
              </div>

              {/* TCP Connections */}
              <div className="p-3 bg-slate-800 rounded-lg">
                <p className="text-slate-400 text-xs mb-1">TCP Connections</p>
                {latestMetrics.tcpTotal != null ? (
                  <>
                    <p className="text-xl font-semibold text-white">
                      {latestMetrics.tcpTotal}
                    </p>
                    <div className="flex gap-2 mt-1 text-xs">
                      <span className="text-green-400">{latestMetrics.tcpEstablished ?? 0} est</span>
                      <span className="text-blue-400">{latestMetrics.tcpListen ?? 0} listen</span>
                      <span className="text-yellow-400">{latestMetrics.tcpTimeWait ?? 0} tw</span>
                    </div>
                  </>
                ) : (
                  <p className="text-slate-500 text-sm">-</p>
                )}
              </div>

              {/* Uptime */}
              <div className="p-3 bg-slate-800 rounded-lg">
                <p className="text-slate-400 text-xs mb-1">Uptime</p>
                {latestMetrics.uptime != null ? (
                  <p className="text-xl font-semibold text-white">
                    {Math.floor(latestMetrics.uptime / 86400)}d{' '}
                    {Math.floor((latestMetrics.uptime % 86400) / 3600)}h
                    <span className="text-sm text-slate-400 ml-1">
                      {Math.floor((latestMetrics.uptime % 3600) / 60)}m
                    </span>
                  </p>
                ) : (
                  <p className="text-slate-500 text-sm">-</p>
                )}
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

        {/* Agent Extraction Helper for Host Servers */}
        {server.serverType === 'host' && agentStatus?.metricsMode === 'agent' && (
          <div className="mt-6 p-4 bg-purple-500/10 border border-purple-500/30 rounded-lg">
            <h4 className="text-sm font-medium text-purple-400 mb-2">
              Manual Agent Setup (Alternative)
            </h4>
            <p className="text-sm text-slate-400 mb-3">
              For host servers, you can also manually extract and run the agent binary:
            </p>
            <div className="space-y-2">
              <div>
                <p className="text-xs text-slate-500 mb-1">1. Extract agent from container:</p>
                <code className="block px-3 py-2 bg-slate-900 rounded text-xs text-slate-300 font-mono overflow-x-auto">
                  docker cp bridgeport:/app/agent/bridgeport-agent ./bridgeport-agent && chmod +x ./bridgeport-agent
                </code>
              </div>
              <div>
                <p className="text-xs text-slate-500 mb-1">2. Run on host:</p>
                <code className="block px-3 py-2 bg-slate-900 rounded text-xs text-slate-300 font-mono overflow-x-auto">
                  ./bridgeport-agent --server http://localhost:3000 --token {agentToken ? agentToken : '<your-token>'}
                </code>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Config Files Sync Status */}
      {(configFilesStatus.length > 0 || loadingConfigFiles) && (
        <div className="panel mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold text-white">Config Files</h3>
              {configFilesTotals && (
                <div className="flex items-center gap-2 text-sm">
                  {configFilesTotals.synced > 0 && (
                    <span className="px-2 py-0.5 rounded bg-green-500/20 text-green-400">
                      {configFilesTotals.synced} synced
                    </span>
                  )}
                  {configFilesTotals.pending > 0 && (
                    <span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                      {configFilesTotals.pending} pending
                    </span>
                  )}
                  {configFilesTotals.never > 0 && (
                    <span className="px-2 py-0.5 rounded bg-slate-600 text-slate-300">
                      {configFilesTotals.never} never synced
                    </span>
                  )}
                </div>
              )}
            </div>
            {(configFilesTotals?.pending || 0) + (configFilesTotals?.never || 0) > 0 && (
              <button
                onClick={handleSyncAllFiles}
                disabled={syncingAllFiles}
                className="btn btn-primary text-sm flex items-center gap-2"
              >
                <RefreshIcon className={`w-4 h-4 ${syncingAllFiles ? 'animate-spin' : ''}`} />
                {syncingAllFiles ? 'Syncing...' : 'Sync All'}
              </button>
            )}
          </div>

          <div className="space-y-2">
            {configFilesStatus.map((cf) => (
              <div
                key={cf.id}
                className={`p-3 rounded-lg bg-slate-800/50 ${
                  cf.overallSyncStatus === 'pending' ? 'border border-yellow-500/30' :
                  cf.overallSyncStatus === 'never' ? 'border border-slate-600' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FileIcon className="w-4 h-4 text-slate-400" />
                    <div>
                      <Link
                        to={`/config-files`}
                        className="text-white hover:text-primary-400 font-medium"
                      >
                        {cf.name}
                      </Link>
                      <span className="text-slate-500 ml-2 text-sm font-mono">{cf.filename}</span>
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 text-xs rounded ${getSyncStatusColor(cf.overallSyncStatus)}`}>
                    {cf.overallSyncStatus === 'synced' ? 'Synced' :
                     cf.overallSyncStatus === 'pending' ? 'Outdated' : 'Never synced'}
                  </span>
                </div>
                {/* Show per-service breakdown if multiple */}
                {cf.attachments.length > 1 && (
                  <div className="mt-2 pl-7 space-y-1">
                    {cf.attachments.map((att) => (
                      <div key={att.serviceFileId} className="flex items-center justify-between text-sm">
                        <div>
                          <Link
                            to={`/services/${att.serviceId}`}
                            className="text-primary-400 hover:text-primary-300"
                          >
                            {att.serviceName}
                          </Link>
                          <span className="text-slate-500 ml-2">→</span>
                          <code className="text-slate-400 ml-2 text-xs">{att.targetPath}</code>
                        </div>
                        <span className={`px-1.5 py-0.5 text-xs rounded ${getSyncStatusColor(att.syncStatus)}`}>
                          {att.syncStatus === 'synced' ? 'Synced' :
                           att.syncStatus === 'pending' ? 'Outdated' : 'Never'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Show single attachment inline */}
                {cf.attachments.length === 1 && (
                  <div className="mt-1 pl-7 text-sm text-slate-400">
                    <Link
                      to={`/services/${cf.attachments[0].serviceId}`}
                      className="text-primary-400 hover:text-primary-300"
                    >
                      {cf.attachments[0].serviceName}
                    </Link>
                    <span className="mx-2">→</span>
                    <code className="text-xs">{cf.attachments[0].targetPath}</code>
                    {cf.attachments[0].lastSyncedAt && (
                      <span className="text-slate-500 ml-2">
                        (synced {formatDistanceToNow(new Date(cf.attachments[0].lastSyncedAt), { addSuffix: true })})
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sync Results Modal */}
      <Modal
        isOpen={showSyncResults}
        onClose={() => {
          setShowSyncResults(false);
          setSyncResults(null);
        }}
        title="Sync Results"
        size="md"
      >
        {syncResults === null ? (
          <div className="flex flex-col items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500 mb-4"></div>
            <p className="text-slate-400">Syncing all config files...</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <div className={`p-3 rounded-lg ${
              syncResults.every(r => r.success)
                ? 'bg-green-500/10 border border-green-500/30'
                : syncResults.some(r => r.success)
                ? 'bg-yellow-500/10 border border-yellow-500/30'
                : 'bg-red-500/10 border border-red-500/30'
            }`}>
              <div className="flex items-center gap-2">
                {syncResults.every(r => r.success) ? (
                  <CheckIcon className="w-5 h-5 text-green-400" />
                ) : (
                  <WarningIcon className="w-5 h-5 text-yellow-400" />
                )}
                <span className={
                  syncResults.every(r => r.success) ? 'text-green-400' :
                  syncResults.some(r => r.success) ? 'text-yellow-400' : 'text-red-400'
                }>
                  {syncResults.filter(r => r.success).length} of {syncResults.length} synced successfully
                </span>
              </div>
            </div>

            {/* Results List */}
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {syncResults.map((result, i) => (
                <div
                  key={i}
                  className={`p-2 rounded-lg text-sm ${
                    result.success ? 'bg-slate-800/50' : 'bg-red-500/10'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-white">{result.configFileName}</span>
                      <span className="text-slate-500"> → </span>
                      <span className="text-primary-400">{result.serviceName}</span>
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
                  setShowSyncResults(false);
                  setSyncResults(null);
                }}
                className="btn btn-primary"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Top Processes (from Agent) */}
      {processSnapshot && (
        <div className="panel mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">
              Top Processes
              {processUpdatedAt && (
                <span className="text-xs text-slate-500 font-normal ml-2">
                  {formatDistanceToNow(new Date(processUpdatedAt), { addSuffix: true })}
                </span>
              )}
            </h3>
            <div className="flex items-center gap-4 text-sm text-slate-400">
              <span>Total: {processSnapshot.stats.total}</span>
              <span className="text-green-400">Running: {processSnapshot.stats.running}</span>
              <span>Sleeping: {processSnapshot.stats.sleeping}</span>
              {processSnapshot.stats.zombie > 0 && (
                <span className="text-red-400">Zombie: {processSnapshot.stats.zombie}</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            {/* Top by CPU */}
            <div>
              <h4 className="text-sm font-medium text-slate-400 mb-3">Top by CPU</h4>
              <div className="space-y-2">
                {processSnapshot.byCpu.slice(0, 10).map((proc) => (
                  <div
                    key={`cpu-${proc.pid}`}
                    className="flex items-center justify-between p-2 bg-slate-800/50 rounded text-sm"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span className="text-slate-500 font-mono text-xs w-12">{proc.pid}</span>
                      <span className="text-white truncate" title={proc.name}>{proc.name}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs shrink-0">
                      <span className={`font-mono ${proc.cpuPercent > 50 ? 'text-red-400' : proc.cpuPercent > 20 ? 'text-yellow-400' : 'text-green-400'}`}>
                        {proc.cpuPercent.toFixed(1)}% CPU
                      </span>
                      <span className="text-slate-400 font-mono">
                        {proc.memoryMb.toFixed(0)} MB
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Top by Memory */}
            <div>
              <h4 className="text-sm font-medium text-slate-400 mb-3">Top by Memory</h4>
              <div className="space-y-2">
                {processSnapshot.byMemory.slice(0, 10).map((proc) => (
                  <div
                    key={`mem-${proc.pid}`}
                    className="flex items-center justify-between p-2 bg-slate-800/50 rounded text-sm"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span className="text-slate-500 font-mono text-xs w-12">{proc.pid}</span>
                      <span className="text-white truncate" title={proc.name}>{proc.name}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs shrink-0">
                      <span className="text-slate-400 font-mono">
                        {proc.cpuPercent.toFixed(1)}% CPU
                      </span>
                      <span className={`font-mono ${proc.memoryMb > 1000 ? 'text-yellow-400' : 'text-primary-400'}`}>
                        {proc.memoryMb.toFixed(0)} MB
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Active Services */}
      {(() => {
        const activeServices = server.services.filter(s => s.discoveryStatus !== 'missing');
        const missingServices = server.services.filter(s => s.discoveryStatus === 'missing');

        return (
          <>
            <div className="panel mb-6">
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
                              {service.containerImage?.imageName?.split('/').pop() || 'unknown'}:{service.imageTag}
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
              <div className="panel border-orange-500/30">
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
                            {service.containerImage?.imageName?.split('/').pop() || 'unknown'}:{service.imageTag}
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
                <label className="block text-sm text-slate-400 mb-1">Container Image *</label>
                <select
                  value={newService.containerImageId}
                  onChange={(e) => setNewService({ ...newService, containerImageId: e.target.value })}
                  className="input font-mono text-sm"
                  required
                >
                  <option value="">Select a container image...</option>
                  {containerImages.map((img) => (
                    <option key={img.id} value={img.id}>
                      {img.name} ({img.imageName})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  <Link to="/container-images" className="text-primary-400 hover:underline">
                    Create a new container image
                  </Link> if not listed
                </p>
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

import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAppStore } from '../lib/store';
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
  getModuleSettings,
  pruneServerImages,
  getBootstrapStatus,
  type ServerWithServices,
  type MetricsMode,
  type ServerMetrics,
  type CreateServiceInput,
  type UpdateServerInput,
  type ExposedPort,
  type ServerConfigFileStatus,
  type ServerConfigFilesSyncTotals,
  type ServerSyncAllResult,
  type SyncStatus,
  type ContainerImage,
  type ProcessSnapshot,
  type BootstrapStatus,
} from '../lib/api';
import BootstrapModal from '../components/BootstrapModal';
import { useToast } from '../components/Toast';
import { formatDistanceToNow } from 'date-fns';
import { RefreshIcon, CheckIcon, WarningIcon, FileIcon, PencilIcon, XIcon } from '../components/Icons';
import { safeJsonParse } from '../lib/helpers';
import { useConfirm } from '@/hooks/useConfirm';
import { statusVariant } from '@/lib/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

function parseExposedPorts(portsJson: string | null | undefined): ExposedPort[] {
  return safeJsonParse(portsJson ?? null, [] as ExposedPort[]);
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
  bundledAgentVersion: string;
  installed: boolean;
  running: boolean;
  error?: string;
}

function getAgentStatusBadge(status: AgentStatusType) {
  switch (status) {
    case 'active':
      return <Badge variant="success">Active</Badge>;
    case 'deploying':
      return (
        <Badge variant="info" className="animate-pulse">
          Deploying...
        </Badge>
      );
    case 'waiting':
      return <Badge variant="warning">Waiting for first push</Badge>;
    case 'stale':
      return <Badge variant="warning">Stale</Badge>;
    case 'offline':
      return <Badge variant="destructive">Offline</Badge>;
    default:
      return <Badge variant="neutral">Unknown</Badge>;
  }
}

export default function ServerDetail() {
  const { id } = useParams<{ id: string }>();
  const setBreadcrumbName = useAppStore((s) => s.setBreadcrumbName);
  const toast = useToast();
  const confirm = useConfirm();
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
  // `no_targets` is a yellow warning ("nothing to sync") — see issue #127.
  const [syncStatus, setSyncStatus] = useState<SyncStatus | undefined>(undefined);
  const [showSyncResults, setShowSyncResults] = useState(false);

  // Process snapshot (from agent)
  const [processSnapshot, setProcessSnapshot] = useState<ProcessSnapshot | null>(null);
  const [processUpdatedAt, setProcessUpdatedAt] = useState<string | null>(null);

  const [pruning, setPruning] = useState(false);

  // Bootstrap state (issue #113)
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatus | null>(null);
  const [showBootstrapModal, setShowBootstrapModal] = useState(false);
  const [loadingBootstrap, setLoadingBootstrap] = useState(false);

  // Metrics config (for filtering disabled metrics)
  const [schedulerConfig, setSchedulerConfig] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (id) {
      setLoading(true);
      Promise.all([
        getServer(id, { includeServices: true }),
        getAgentStatus(id),
        getServerMetrics(id, undefined, undefined, 1),
        getServerProcesses(id),
      ])
        .then(([serverRes, statusRes, metricsRes, processRes]) => {
          setServer(serverRes.server);
          if (id) setBreadcrumbName(id, serverRes.server.name);
          setAgentStatus(statusRes);
          if (metricsRes.metrics.length > 0) {
            setLatestMetrics(metricsRes.metrics[0]);
          }
          if (processRes.hasData && processRes.processes) {
            setProcessSnapshot(processRes.processes);
            setProcessUpdatedAt(processRes.updatedAt);
          }
          // Load container images and scheduler config for the server's environment
          if (serverRes.server.environmentId) {
            listContainerImages(serverRes.server.environmentId)
              .then(({ images }) => setContainerImages(images))
              .catch(() => setContainerImages([]));
            // Load monitoring settings for metrics toggles
            getModuleSettings(serverRes.server.environmentId, 'monitoring')
              .then(({ settings }) => setSchedulerConfig(settings))
              .catch(() => setSchedulerConfig(null));
          }
        })
        .finally(() => setLoading(false));

      // Load config files sync status
      loadConfigFilesStatus(id);
      // Load bootstrap status (best effort)
      loadBootstrap(id);
    }
  }, [id]);

  const loadBootstrap = async (serverId: string) => {
    setLoadingBootstrap(true);
    try {
      const status = await getBootstrapStatus(serverId);
      setBootstrapStatus(status);
    } catch {
      setBootstrapStatus(null);
    } finally {
      setLoadingBootstrap(false);
    }
  };

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
    setSyncStatus(undefined);
    setShowSyncResults(true);
    try {
      const result = await syncAllServerFiles(id);
      setSyncResults(result.results);
      setSyncStatus(result.status);
      // Reload config files status
      await loadConfigFilesStatus(id);
      if (result.status === 'no_targets') {
        toast.warning('No files attached to services on this server — nothing to sync');
      } else if (result.status === 'ok') {
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
      setSyncStatus('failed');
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
    if (!(await confirm({
      title: 'Delete service',
      description: `Delete service "${serviceName}"? This cannot be undone.`,
      destructive: true,
    }))) return;
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
    if (!(await confirm({
      title: 'Regenerate agent token',
      description: 'Regenerate agent token? The existing agent will need to be redeployed.',
      destructive: true,
    }))) return;
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
    if (!(await confirm({
      title: 'Remove agent',
      description: 'Remove the monitoring agent from this server?',
      destructive: true,
    }))) return;
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

  const handlePruneImages = async () => {
    if (!id) return;
    if (!(await confirm({
      title: 'Prune dangling images',
      description: 'Prune dangling Docker images on this server? This removes untagged image layers that are no longer referenced by any container.',
      destructive: true,
    }))) return;
    setPruning(true);
    try {
      const result = await pruneServerImages(id, 'dangling');
      toast.success(`Images pruned — ${result.spaceReclaimedHuman} freed`);
    } catch (error) {
      toast.error('Failed to prune images');
    } finally {
      setPruning(false);
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
      // Newly-created Service template has no deployment runtime fields yet; the
      // back-compat surface treats them as optional, so we just append the row.
      setServer((prev) => prev ? { ...prev, services: [...prev.services, service as typeof prev.services[number]] } : null);
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
      tags: safeJsonParse(server.tags, [] as string[]),
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
      setBreadcrumbName(id, updatedServer.name);
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
    if (!(await confirm({
      title: 'Delete server',
      description: `Delete server "${server.name}"? This will also delete all services on this server. This cannot be undone.`,
      destructive: true,
    }))) return;
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
      <div className="p-6 space-y-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!server) {
    return (
      <div className="p-6">
        <Card className="text-center py-12">
          <p className="text-muted-foreground">Server not found</p>
          <Button asChild className="mt-4">
            <Link to="/servers">Back to Servers</Link>
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-3">
            <span
              className={`w-3 h-3 rounded-full ${
                server.status === 'healthy'
                  ? 'bg-success'
                  : server.status === 'unhealthy'
                  ? 'bg-destructive'
                  : 'bg-warning'
              }`}
            />
            <span className="text-xl font-bold text-foreground">{server.name}</span>
            {server.serverType === 'host' && (
              <Badge variant="info">Host Server</Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-1">
            {server.hostname}
            {server.publicIp && ` • Public: ${server.publicIp}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={openEditServer}
            title="Edit Server"
          >
            <PencilIcon className="w-5 h-5" />
          </Button>
          <Button variant="ghost" onClick={() => setShowCreateService(true)}>
            Create Service
          </Button>
          <Button
            variant="secondary"
            onClick={handleDiscover}
            disabled={actionLoading}
          >
            {actionLoading ? 'Loading...' : 'Discover Containers'}
          </Button>
          <Button onClick={handleHealthCheck} disabled={actionLoading}>
            {actionLoading ? 'Checking...' : 'Health Check'}
          </Button>
        </div>
      </div>

      {/* Server Info */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <Card className="p-4">
          <h3 className="text-lg font-semibold text-foreground mb-4">Details</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <StatusBadge kind="server" value={server.status} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Private IP</dt>
              <dd className="font-mono text-foreground">{server.hostname}</dd>
            </div>
            {server.publicIp && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Public IP</dt>
                <dd className="font-mono text-foreground">{server.publicIp}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Last Checked</dt>
              <dd className="text-foreground">
                {server.lastCheckedAt
                  ? formatDistanceToNow(new Date(server.lastCheckedAt), {
                      addSuffix: true,
                    })
                  : 'Never'}
              </dd>
            </div>
          </dl>
        </Card>

        <Card className="p-4">
          <h3 className="text-lg font-semibold text-foreground mb-4">Tags</h3>
          <div className="flex flex-wrap gap-2">
            {safeJsonParse(server.tags, [] as string[]).map((tag: string) => (
                <Badge key={tag} variant="neutral">
                  {tag}
                </Badge>
              ))}
            {safeJsonParse(server.tags, [] as string[]).length === 0 && (
              <p className="text-muted-foreground">No tags</p>
            )}
          </div>
        </Card>
      </div>

      {/* Bootstrap Card (issue #113) */}
      <Card className="p-4 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-foreground">Bootstrap</h3>
            {bootstrapStatus && (
              <Badge
                variant={
                  bootstrapStatus.bootstrapState === 'bootstrapped'
                    ? 'success'
                    : bootstrapStatus.bootstrapState === 'error'
                    ? 'destructive'
                    : 'neutral'
                }
              >
                {bootstrapStatus.bootstrapState === 'bootstrapped'
                  ? 'Bootstrapped'
                  : bootstrapStatus.bootstrapState === 'error'
                  ? 'Error'
                  : 'Not bootstrapped'}
              </Badge>
            )}
            {bootstrapStatus?.bootstrapDistro && (
              <span className="text-xs text-muted-foreground font-mono">
                {bootstrapStatus.bootstrapDistro}
              </span>
            )}
          </div>
          <Button
            variant="secondary"
            onClick={() => setShowBootstrapModal(true)}
            disabled={loadingBootstrap}
            title="Install Docker, sysctl, agent, and (optionally) swap on this server"
          >
            Bootstrap server
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {([
            ['Docker', bootstrapStatus?.dockerInstalled ?? false, bootstrapStatus?.dockerInstalledAt],
            ['sysctl', bootstrapStatus?.sysctlApplied ?? false, bootstrapStatus?.sysctlAppliedAt],
            ['Agent', bootstrapStatus?.agentInstalled ?? false, bootstrapStatus?.agentInstalledAt],
            [
              'Swap',
              bootstrapStatus?.swapConfigured ?? false,
              bootstrapStatus?.swapConfiguredAt,
              bootstrapStatus?.swapSizeMb
                ? `${bootstrapStatus.swapSizeMb} MB`
                : undefined,
            ],
          ] as Array<[string, boolean, string | null | undefined, string?]>).map(
            ([label, done, at, extra]) => (
              <div
                key={label}
                className={`p-3 rounded-lg border ${
                  done
                    ? 'border-success/30 bg-success/5'
                    : 'border-border bg-muted/50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-foreground font-medium">{label}</span>
                  <Badge variant={done ? 'success' : 'neutral'}>
                    {done ? 'Installed' : 'Pending'}
                  </Badge>
                </div>
                {extra && <p className="text-xs text-muted-foreground mt-1">{extra}</p>}
                {at && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatDistanceToNow(new Date(at), { addSuffix: true })}
                  </p>
                )}
              </div>
            ),
          )}
        </div>

        {bootstrapStatus?.distro && !bootstrapStatus.distro.supported && (
          <p className="mt-3 text-sm text-warning">
            Detected distro <span className="font-mono">{bootstrapStatus.distro.raw || 'unknown'}</span>{' '}
            is not supported. Bootstrap works on Ubuntu and Debian only.
          </p>
        )}
        {bootstrapStatus?.sudo && !bootstrapStatus.sudo.ok && (
          <p className="mt-3 text-sm text-warning">
            Passwordless sudo not detected. Configure NOPASSWD or use root SSH before running bootstrap.
          </p>
        )}
      </Card>

      {/* Monitoring Card */}
      <Card className="p-4 mb-6">
        <h3 className="text-lg font-semibold text-foreground mb-4">Monitoring</h3>

        {/* Mode Selection */}
        <div className="mb-6">
          <Label className="mb-2 block">Mode</Label>
          <RadioGroup
            className="flex gap-4"
            value={agentStatus?.metricsMode}
            onValueChange={(value) => handleModeChange(value as MetricsMode)}
            disabled={modeChanging}
          >
            {(['disabled', 'ssh', 'agent'] as const).map((mode) => (
              <div key={mode} className="flex items-center gap-2">
                <RadioGroupItem value={mode} id={`metrics-mode-${mode}`} />
                <Label htmlFor={`metrics-mode-${mode}`} className="text-foreground capitalize cursor-pointer">
                  {mode === 'ssh' ? 'SSH' : mode}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>

        {/* Mode-specific content */}
        {agentStatus?.metricsMode === 'ssh' && (
          <div className="mb-6 p-4 bg-muted rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-muted-foreground text-sm">Status</p>
                <p className="text-foreground">
                  {latestMetrics
                    ? `Last collected ${formatDistanceToNow(new Date(latestMetrics.collectedAt), { addSuffix: true })}`
                    : 'No metrics collected yet'}
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={handleCollectMetrics}
                disabled={metricsLoading}
              >
                {metricsLoading ? 'Collecting...' : 'Collect Now'}
              </Button>
            </div>
          </div>
        )}

        {agentStatus?.metricsMode === 'agent' && (
          <div className="mb-6 p-4 bg-muted rounded-lg space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-muted-foreground text-sm">Agent Status</p>
                <div className="flex items-center gap-3 mt-1">
                  {getAgentStatusBadge(agentStatus.agentStatus)}
                  {agentStatus.agentVersion && (
                    <span className="text-muted-foreground text-sm">
                      v{agentStatus.agentVersion}
                    </span>
                  )}
                  {agentStatus.agentVersion &&
                    agentStatus.bundledAgentVersion &&
                    agentStatus.bundledAgentVersion !== 'unknown' &&
                    agentStatus.agentVersion !== agentStatus.bundledAgentVersion && (
                    <Badge variant="warning">
                      Update available ({agentStatus.bundledAgentVersion})
                    </Badge>
                  )}
                  {agentStatus.lastAgentPushAt && (
                    <span className="text-muted-foreground text-sm">
                      Last push: {formatDistanceToNow(new Date(agentStatus.lastAgentPushAt), { addSuffix: true })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                {agentStatus.installed ? (
                  <>
                    {agentStatus.agentVersion &&
                      agentStatus.bundledAgentVersion &&
                      agentStatus.bundledAgentVersion !== 'unknown' &&
                      agentStatus.agentVersion !== agentStatus.bundledAgentVersion && (
                      <Button onClick={handleDeployAgent} disabled={modeChanging}>
                        {modeChanging ? 'Updating...' : 'Update Agent'}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      onClick={handleRemoveAgent}
                      disabled={modeChanging}
                      className="text-destructive"
                    >
                      Remove Agent
                    </Button>
                  </>
                ) : (
                  <Button onClick={handleDeployAgent} disabled={modeChanging}>
                    {modeChanging ? 'Deploying...' : 'Deploy Agent'}
                  </Button>
                )}
              </div>
            </div>

            {agentStatus.hasToken && (
              <div>
                <p className="text-muted-foreground text-sm mb-2">Agent Token</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-background rounded text-sm text-foreground font-mono">
                    {agentToken ? agentToken : '••••••••••••••••'}
                  </code>
                  {agentToken && (
                    <Button variant="secondary" size="sm" onClick={copyToken}>
                      {tokenCopied ? 'Copied!' : 'Copy'}
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={handleRegenerateToken}>
                    Regenerate
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Recent Metrics */}
        {latestMetrics && agentStatus?.metricsMode !== 'disabled' && (
          <div>
            <p className="text-muted-foreground text-sm mb-3">Recent Metrics</p>
            {/* Primary metrics row */}
            <div className="grid grid-cols-4 gap-4 mb-4">
              {/* CPU */}
              {(schedulerConfig?.collectCpu ?? true) && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-muted-foreground text-xs mb-1">CPU</p>
                  <p className="text-xl font-semibold text-foreground">
                    {latestMetrics.cpuPercent?.toFixed(1) ?? '-'}%
                  </p>
                  <div className="h-1 mt-2 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full"
                      style={{ width: `${Math.min(latestMetrics.cpuPercent || 0, 100)}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Memory */}
              {(schedulerConfig?.collectMemory ?? true) && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-muted-foreground text-xs mb-1">Memory</p>
                  <p className="text-xl font-semibold text-foreground">
                    {latestMetrics.memoryUsedMb
                      ? `${(latestMetrics.memoryUsedMb / 1024).toFixed(1)}`
                      : '-'}
                    <span className="text-sm text-muted-foreground">
                      /{latestMetrics.memoryTotalMb ? (latestMetrics.memoryTotalMb / 1024).toFixed(0) : '-'}GB
                    </span>
                  </p>
                  {latestMetrics.memoryTotalMb && (
                    <div className="h-1 mt-2 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-success rounded-full"
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
              )}

              {/* Disk */}
              {(schedulerConfig?.collectDisk ?? true) && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-muted-foreground text-xs mb-1">Disk</p>
                  <p className="text-xl font-semibold text-foreground">
                    {latestMetrics.diskUsedGb?.toFixed(0) ?? '-'}
                    <span className="text-sm text-muted-foreground">
                      /{latestMetrics.diskTotalGb?.toFixed(0) ?? '-'}GB
                    </span>
                  </p>
                  {latestMetrics.diskTotalGb && (
                    <div className="h-1 mt-2 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-warning rounded-full"
                        style={{
                          width: `${Math.min(
                            ((latestMetrics.diskUsedGb || 0) / latestMetrics.diskTotalGb) * 100,
                            100
                          )}%`,
                        }}
                      />
                    </div>
                  )}
                  <button
                    onClick={handlePruneImages}
                    disabled={pruning}
                    className="mt-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {pruning ? 'Pruning...' : 'Prune images'}
                  </button>
                </div>
              )}

              {/* Load */}
              {(schedulerConfig?.collectLoad ?? true) && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-muted-foreground text-xs mb-1">Load Avg</p>
                  <p className="text-xl font-semibold text-foreground font-mono">
                    {latestMetrics.loadAvg1?.toFixed(2) ?? '-'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {latestMetrics.loadAvg5?.toFixed(2)} / {latestMetrics.loadAvg15?.toFixed(2)}
                  </p>
                </div>
              )}
            </div>

            {/* Secondary metrics row (swap, FDs, TCP, uptime) */}
            <div className="grid grid-cols-4 gap-4">
              {/* Swap */}
              {(schedulerConfig?.collectSwap ?? true) && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-muted-foreground text-xs mb-1">Swap</p>
                  {latestMetrics.swapTotalMb && latestMetrics.swapTotalMb > 0 ? (
                    <>
                      <p className="text-xl font-semibold text-foreground">
                        {((latestMetrics.swapUsedMb || 0) / 1024).toFixed(1)}
                        <span className="text-sm text-muted-foreground">
                          /{(latestMetrics.swapTotalMb / 1024).toFixed(0)}GB
                        </span>
                      </p>
                      <div className="h-1 mt-2 bg-secondary rounded-full overflow-hidden">
                        <div
                          className="h-full bg-info rounded-full"
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
                    <p className="text-muted-foreground text-sm">No swap</p>
                  )}
                </div>
              )}

              {/* File Descriptors */}
              {(schedulerConfig?.collectFds ?? true) && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-muted-foreground text-xs mb-1">File Descriptors</p>
                  {latestMetrics.openFds != null && latestMetrics.maxFds ? (
                    <>
                      <p className="text-xl font-semibold text-foreground">
                        {(latestMetrics.openFds / 1000).toFixed(1)}k
                        <span className="text-sm text-muted-foreground">
                          /{(latestMetrics.maxFds / 1000).toFixed(0)}k
                        </span>
                      </p>
                      <div className="h-1 mt-2 bg-secondary rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            (latestMetrics.openFds / latestMetrics.maxFds) > 0.8
                              ? 'bg-destructive'
                              : (latestMetrics.openFds / latestMetrics.maxFds) > 0.6
                              ? 'bg-warning'
                              : 'bg-success'
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
                    <p className="text-muted-foreground text-sm">-</p>
                  )}
                </div>
              )}

              {/* TCP Connections */}
              {(schedulerConfig?.collectTcp ?? true) && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-muted-foreground text-xs mb-1">TCP Connections</p>
                  {latestMetrics.tcpTotal != null ? (
                    <>
                      <p className="text-xl font-semibold text-foreground">
                        {latestMetrics.tcpTotal}
                      </p>
                      <div className="flex gap-2 mt-1 text-xs">
                        <span className="text-success">{latestMetrics.tcpEstablished ?? 0} est</span>
                        <span className="text-info">{latestMetrics.tcpListen ?? 0} listen</span>
                        <span className="text-warning">{latestMetrics.tcpTimeWait ?? 0} tw</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-muted-foreground text-sm">-</p>
                  )}
                </div>
              )}

              {/* Uptime - always shown as it's not configurable */}
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground text-xs mb-1">Uptime</p>
                {latestMetrics.uptime != null ? (
                  <p className="text-xl font-semibold text-foreground">
                    {Math.floor(latestMetrics.uptime / 86400)}d{' '}
                    {Math.floor((latestMetrics.uptime % 86400) / 3600)}h
                    <span className="text-sm text-muted-foreground ml-1">
                      {Math.floor((latestMetrics.uptime % 3600) / 60)}m
                    </span>
                  </p>
                ) : (
                  <p className="text-muted-foreground text-sm">-</p>
                )}
              </div>
            </div>
          </div>
        )}

        {!latestMetrics && agentStatus?.metricsMode !== 'disabled' && (
          <p className="text-muted-foreground text-sm">
            No metrics available.{' '}
            {agentStatus?.metricsMode === 'ssh' && 'Click "Collect Now" to gather metrics.'}
            {agentStatus?.metricsMode === 'agent' && !agentStatus.installed && 'Deploy the agent to start collecting metrics.'}
          </p>
        )}

        {/* Agent Extraction Helper for Host Servers */}
        {server.serverType === 'host' && agentStatus?.metricsMode === 'agent' && (
          <div className="mt-6 p-4 bg-info/10 border border-info/30 rounded-lg">
            <h4 className="text-sm font-medium text-info mb-2">
              Manual Agent Setup (Alternative)
            </h4>
            <p className="text-sm text-muted-foreground mb-3">
              For host servers, you can also manually extract and run the agent binary:
            </p>
            <div className="space-y-2">
              <div>
                <p className="text-xs text-muted-foreground mb-1">1. Extract agent from container:</p>
                <code className="block px-3 py-2 bg-background rounded text-xs text-foreground font-mono overflow-x-auto">
                  docker cp bridgeport:/app/agent/bridgeport-agent ./bridgeport-agent && chmod +x ./bridgeport-agent
                </code>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">2. Run on host:</p>
                <code className="block px-3 py-2 bg-background rounded text-xs text-foreground font-mono overflow-x-auto">
                  ./bridgeport-agent --server http://localhost:3000 --token {agentToken ? agentToken : '<your-token>'}
                </code>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Config Files Sync Status */}
      {(configFilesStatus.length > 0 || loadingConfigFiles) && (
        <Card className="p-4 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold text-foreground">Config Files</h3>
              {configFilesTotals && (
                <div className="flex items-center gap-2 text-sm">
                  {configFilesTotals.synced > 0 && (
                    <Badge variant="success">{configFilesTotals.synced} synced</Badge>
                  )}
                  {configFilesTotals.pending > 0 && (
                    <Badge variant="warning">{configFilesTotals.pending} pending</Badge>
                  )}
                  {configFilesTotals.never > 0 && (
                    <Badge variant="neutral">{configFilesTotals.never} never synced</Badge>
                  )}
                </div>
              )}
            </div>
            {(configFilesTotals?.pending || 0) + (configFilesTotals?.never || 0) > 0 && (
              <Button
                size="sm"
                onClick={handleSyncAllFiles}
                disabled={syncingAllFiles}
              >
                <RefreshIcon className={`w-4 h-4 ${syncingAllFiles ? 'animate-spin' : ''}`} />
                {syncingAllFiles ? 'Syncing...' : 'Sync All'}
              </Button>
            )}
          </div>

          <div className="space-y-2">
            {configFilesStatus.map((cf) => (
              <div
                key={cf.id}
                className={`p-3 rounded-lg bg-muted/50 ${
                  cf.overallSyncStatus === 'pending' ? 'border border-warning/30' :
                  cf.overallSyncStatus === 'never' ? 'border border-border' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FileIcon className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <Link
                        to={`/config-files`}
                        className="text-foreground hover:text-primary font-medium"
                      >
                        {cf.name}
                      </Link>
                      <span className="text-muted-foreground ml-2 text-sm font-mono">{cf.filename}</span>
                    </div>
                  </div>
                  <Badge variant={statusVariant('sync', cf.overallSyncStatus)}>
                    {cf.overallSyncStatus === 'synced' ? 'Synced' :
                     cf.overallSyncStatus === 'pending' ? 'Outdated' : 'Never synced'}
                  </Badge>
                </div>
                {/* Show per-service breakdown if multiple */}
                {cf.attachments.length > 1 && (
                  <div className="mt-2 pl-7 space-y-1">
                    {cf.attachments.map((att) => (
                      <div key={att.serviceFileId} className="flex items-center justify-between text-sm">
                        <div>
                          <Link
                            to={`/services/${att.serviceId}`}
                            className="text-primary hover:text-primary/80"
                          >
                            {att.serviceName}
                          </Link>
                          <span className="text-muted-foreground ml-2">→</span>
                          <code className="text-muted-foreground ml-2 text-xs">{att.targetPath}</code>
                        </div>
                        <Badge variant={statusVariant('sync', att.syncStatus)}>
                          {att.syncStatus === 'synced' ? 'Synced' :
                           att.syncStatus === 'pending' ? 'Outdated' : 'Never'}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
                {/* Show single attachment inline */}
                {cf.attachments.length === 1 && (
                  <div className="mt-1 pl-7 text-sm text-muted-foreground">
                    <Link
                      to={`/services/${cf.attachments[0].serviceId}`}
                      className="text-primary hover:text-primary/80"
                    >
                      {cf.attachments[0].serviceName}
                    </Link>
                    <span className="mx-2">→</span>
                    <code className="text-xs">{cf.attachments[0].targetPath}</code>
                    {cf.attachments[0].lastSyncedAt && (
                      <span className="text-muted-foreground ml-2">
                        (synced {formatDistanceToNow(new Date(cf.attachments[0].lastSyncedAt), { addSuffix: true })})
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Sync Results Modal */}
      <Dialog
        open={showSyncResults}
        onOpenChange={(open) => {
          if (!open) {
            setShowSyncResults(false);
            setSyncResults(null);
            setSyncStatus(undefined);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sync Results</DialogTitle>
          </DialogHeader>
          {syncResults === null ? (
            <div className="flex flex-col items-center justify-center py-8">
              <RefreshIcon className="w-8 h-8 text-primary mb-4 animate-spin" />
              <p className="text-muted-foreground">Syncing all config files...</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Summary */}
              <div className={`p-3 rounded-lg ${
                syncStatus === 'no_targets'
                  ? 'bg-warning/10 border border-warning/30'
                  : syncResults.every(r => r.success)
                  ? 'bg-success/10 border border-success/30'
                  : syncResults.some(r => r.success)
                  ? 'bg-warning/10 border border-warning/30'
                  : 'bg-destructive/10 border border-destructive/30'
              }`}>
                <div className="flex items-center gap-2">
                  {syncStatus === 'no_targets' ? (
                    // `no_targets` → "nothing to sync" warning (issue #127).
                    // Server has no services with attached config files; render
                    // as yellow info instead of a green success.
                    <WarningIcon className="w-5 h-5 text-warning" />
                  ) : syncResults.every(r => r.success) ? (
                    <CheckIcon className="w-5 h-5 text-success" />
                  ) : (
                    <WarningIcon className="w-5 h-5 text-warning" />
                  )}
                  <span className={
                    syncStatus === 'no_targets' ? 'text-warning' :
                    syncResults.every(r => r.success) ? 'text-success' :
                    syncResults.some(r => r.success) ? 'text-warning' : 'text-destructive'
                  }>
                    {syncStatus === 'no_targets'
                      ? 'No config files attached to services on this server — sync did nothing.'
                      : `${syncResults.filter(r => r.success).length} of ${syncResults.length} synced successfully`}
                  </span>
                </div>
              </div>

              {/* Results List */}
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {syncResults.map((result, i) => (
                  <div
                    key={i}
                    className={`p-2 rounded-lg text-sm ${
                      result.success ? 'bg-muted/50' : 'bg-destructive/10'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-foreground">{result.configFileName}</span>
                        <span className="text-muted-foreground"> → </span>
                        <span className="text-primary">{result.serviceName}</span>
                      </div>
                      {result.success ? (
                        <CheckIcon className="w-4 h-4 text-success" />
                      ) : (
                        <WarningIcon className="w-4 h-4 text-destructive" />
                      )}
                    </div>
                    {result.error && (
                      <p className="text-destructive text-xs mt-1">{result.error}</p>
                    )}
                  </div>
                ))}
              </div>

              <DialogFooter>
                <Button
                  onClick={() => {
                    setShowSyncResults(false);
                    setSyncResults(null);
                    setSyncStatus(undefined);
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Top Processes (from Agent) */}
      {processSnapshot && (schedulerConfig?.collectProcesses ?? true) && (
        <Card className="p-4 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-foreground">
              Top Processes
              {processUpdatedAt && (
                <span className="text-xs text-muted-foreground font-normal ml-2">
                  {formatDistanceToNow(new Date(processUpdatedAt), { addSuffix: true })}
                </span>
              )}
            </h3>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span>Total: {processSnapshot.stats.total}</span>
              <span className="text-success">Running: {processSnapshot.stats.running}</span>
              <span>Sleeping: {processSnapshot.stats.sleeping}</span>
              {processSnapshot.stats.zombie > 0 && (
                <span className="text-destructive">Zombie: {processSnapshot.stats.zombie}</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            {/* Top by CPU */}
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-3">Top by CPU</h4>
              <div className="space-y-2">
                {processSnapshot.byCpu.slice(0, 10).map((proc) => (
                  <div
                    key={`cpu-${proc.pid}`}
                    className="flex items-center justify-between p-2 bg-muted/50 rounded text-sm"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span className="text-muted-foreground font-mono text-xs w-12">{proc.pid}</span>
                      <span className="text-foreground truncate" title={proc.name}>{proc.name}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs shrink-0">
                      <span className={`font-mono ${proc.cpuPercent > 50 ? 'text-destructive' : proc.cpuPercent > 20 ? 'text-warning' : 'text-success'}`}>
                        {proc.cpuPercent.toFixed(1)}% CPU
                      </span>
                      <span className="text-muted-foreground font-mono">
                        {proc.memoryMb.toFixed(0)} MB
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Top by Memory */}
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-3">Top by Memory</h4>
              <div className="space-y-2">
                {processSnapshot.byMemory.slice(0, 10).map((proc) => (
                  <div
                    key={`mem-${proc.pid}`}
                    className="flex items-center justify-between p-2 bg-muted/50 rounded text-sm"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span className="text-muted-foreground font-mono text-xs w-12">{proc.pid}</span>
                      <span className="text-foreground truncate" title={proc.name}>{proc.name}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs shrink-0">
                      <span className="text-muted-foreground font-mono">
                        {proc.cpuPercent.toFixed(1)}% CPU
                      </span>
                      <span className={`font-mono ${proc.memoryMb > 1000 ? 'text-warning' : 'text-primary'}`}>
                        {proc.memoryMb.toFixed(0)} MB
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Active Services */}
      {(() => {
        const activeServices = server.services.filter(s => s.discoveryStatus !== 'missing');
        const missingServices = server.services.filter(s => s.discoveryStatus === 'missing');

        return (
          <>
            <Card className="p-4 mb-6">
              <h3 className="text-lg font-semibold text-foreground mb-4">
                Services ({activeServices.length})
              </h3>
              {activeServices.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Container</TableHead>
                        <TableHead>Image</TableHead>
                        <TableHead>Ports</TableHead>
                        <TableHead>Container</TableHead>
                        <TableHead>Health</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {activeServices.map((service) => {
                        const ports = parseExposedPorts(service.exposedPorts);
                        return (
                          <TableRow key={service.id}>
                            <TableCell>
                              <Link
                                to={`/services/${service.id}`}
                                className="text-foreground hover:text-primary"
                              >
                                {service.name}
                              </Link>
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              {service.containerName}
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              {service.containerImage?.imageName?.split('/').pop() || 'unknown'}:{service.imageTag}
                            </TableCell>
                            <TableCell className="font-mono text-sm text-muted-foreground">
                              {formatPorts(ports)}
                            </TableCell>
                            <TableCell>
                              <StatusBadge
                                kind="container"
                                value={service.containerStatus || service.status || 'unknown'}
                              />
                            </TableCell>
                            <TableCell>
                              <StatusBadge
                                kind="health"
                                value={service.healthStatus || 'unknown'}
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <Link
                                to={`/services/${service.id}`}
                                className="text-primary hover:text-primary/80 text-sm"
                              >
                                View
                              </Link>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-muted-foreground">
                  No services discovered. Click "Discover Containers" to scan for Docker containers.
                </p>
              )}
            </Card>

            {/* Missing Services */}
            {missingServices.length > 0 && (
              <Card className="p-4 border-warning/30">
                <h3 className="text-lg font-semibold text-warning mb-4">
                  Missing Services ({missingServices.length})
                </h3>
                <p className="text-muted-foreground text-sm mb-4">
                  These services were previously discovered but are no longer running on the server.
                </p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Container</TableHead>
                        <TableHead>Image</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Last Seen</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {missingServices.map((service) => (
                        <TableRow key={service.id}>
                          <TableCell>
                            <Link
                              to={`/services/${service.id}`}
                              className="text-foreground hover:text-primary"
                            >
                              {service.name}
                            </Link>
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {service.containerName}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {service.containerImage?.imageName?.split('/').pop() || 'unknown'}:{service.imageTag}
                          </TableCell>
                          <TableCell>
                            <StatusBadge
                              kind="container"
                              value={service.containerStatus || 'not_found'}
                            />
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {service.lastDiscoveredAt
                              ? formatDistanceToNow(new Date(service.lastDiscoveredAt), {
                                  addSuffix: true,
                                })
                              : 'Unknown'}
                          </TableCell>
                          <TableCell className="text-right space-x-3">
                            <Link
                              to={`/services/${service.id}`}
                              className="text-primary hover:text-primary/80 text-sm"
                            >
                              View
                            </Link>
                            <button
                              onClick={() => handleDeleteService(service.id, service.name)}
                              className="text-destructive hover:text-destructive/80 text-sm"
                            >
                              Delete
                            </button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            )}
          </>
        );
      })()}

      {/* Create Service Modal */}
      <Dialog open={showCreateService} onOpenChange={(open) => {
        if (!open) {
          setShowCreateService(false);
          setCreateError(null);
        }
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Service</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateService} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="create-service-name">Service Name *</Label>
              <Input
                id="create-service-name"
                type="text"
                value={newService.name}
                onChange={(e) => setNewService({ ...newService, name: e.target.value })}
                placeholder="e.g., app-api"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-service-container">Container Name *</Label>
              <Input
                id="create-service-container"
                type="text"
                value={newService.containerName}
                onChange={(e) => setNewService({ ...newService, containerName: e.target.value })}
                placeholder="e.g., app-api-container"
                className="font-mono text-sm"
                required
              />
              <p className="text-xs text-muted-foreground">Docker container name to manage</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-service-image">Container Image *</Label>
              <Select
                value={newService.containerImageId}
                onValueChange={(value) => setNewService({ ...newService, containerImageId: value })}
                required
              >
                <SelectTrigger id="create-service-image" className="font-mono text-sm">
                  <SelectValue placeholder="Select a container image..." />
                </SelectTrigger>
                <SelectContent>
                  {containerImages.map((img) => (
                    <SelectItem key={img.id} value={img.id}>
                      {img.name} ({img.imageName})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                <Link to="/container-images" className="text-primary hover:underline">
                  Create a new container image
                </Link> if not listed
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-service-tag">Image Tag</Label>
              <Input
                id="create-service-tag"
                type="text"
                value={newService.imageTag}
                onChange={(e) => setNewService({ ...newService, imageTag: e.target.value })}
                placeholder="latest"
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-service-compose">Compose Path</Label>
              <Input
                id="create-service-compose"
                type="text"
                value={newService.composePath}
                onChange={(e) => setNewService({ ...newService, composePath: e.target.value })}
                placeholder="/opt/app/docker-compose.yml"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">Path to docker-compose.yml on server</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-service-health">Health Check URL</Label>
              <Input
                id="create-service-health"
                type="text"
                value={newService.healthCheckUrl}
                onChange={(e) => setNewService({ ...newService, healthCheckUrl: e.target.value })}
                placeholder="http://localhost:8000/health"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">URL to check during health checks (from the server)</p>
            </div>

            {createError && (
              <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
                {createError}
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowCreateService(false);
                  setCreateError(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? 'Creating...' : 'Create Service'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Bootstrap Modal (issue #113) */}
      {id && (
        <BootstrapModal
          isOpen={showBootstrapModal}
          onClose={() => {
            setShowBootstrapModal(false);
            loadBootstrap(id);
          }}
          serverId={id}
          status={bootstrapStatus}
          onComplete={() => loadBootstrap(id)}
        />
      )}

      {/* Edit Server Modal */}
      <Dialog open={showEditServer} onOpenChange={(open) => {
        if (!open) {
          setShowEditServer(false);
          setEditServerError(null);
        }
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Server</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditServer} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-server-name">Server Name *</Label>
              <Input
                id="edit-server-name"
                type="text"
                value={editServerData.name}
                onChange={(e) => setEditServerData({ ...editServerData, name: e.target.value })}
                placeholder="e.g., app-api-staging"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-server-hostname">Hostname / Private IP *</Label>
              <Input
                id="edit-server-hostname"
                type="text"
                value={editServerData.hostname}
                onChange={(e) => setEditServerData({ ...editServerData, hostname: e.target.value })}
                placeholder="e.g., 10.20.10.3"
                className="font-mono text-sm"
                required
              />
              <p className="text-xs text-muted-foreground">IP or hostname used to connect via SSH</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-server-public-ip">Public IP</Label>
              <Input
                id="edit-server-public-ip"
                type="text"
                value={editServerData.publicIp || ''}
                onChange={(e) => setEditServerData({ ...editServerData, publicIp: e.target.value })}
                placeholder="e.g., 123.45.67.89"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">Public-facing IP address (optional)</p>
            </div>
            <div className="space-y-2">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-2 mb-2">
                {(editServerData.tags || []).map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-1 bg-muted rounded text-sm text-foreground flex items-center gap-1"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeEditTag(tag)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <XIcon className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
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
                  className="flex-1"
                />
                <Button type="button" variant="secondary" onClick={addEditTag}>
                  Add
                </Button>
              </div>
            </div>

            {editServerError && (
              <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
                {editServerError}
              </div>
            )}

            <div className="flex gap-2 justify-between pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={handleDeleteServer}
                className="text-destructive hover:text-destructive/80"
              >
                Delete Server
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setShowEditServer(false);
                    setEditServerError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={editingServer}>
                  {editingServer ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

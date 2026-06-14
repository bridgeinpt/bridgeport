import { useEffect, useLayoutEffect, useState, useRef, Fragment } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  getService,
  deployService,
  restartService,
  deleteService,
  getServiceLogs,
  getDeploymentHistory,
  updateService,
  checkServiceHealth,
  listServiceFiles,
  listConfigFiles,
  createConfigFile,
  getConfigFile,
  attachServiceFile,
  detachServiceFile,
  updateServiceFile,
  syncServiceFiles,
  checkServiceUpdates,
  getAuditLogs,
  getServiceHistory,
  getServiceDependencies,
  getContainerImage,
  listServiceTypes,
  getModuleSettings,
  type ServiceWithServer,
  type Deployment,
  type ServiceFile,
  type ConfigFile,
  type SyncResult,
  type SyncStatus,
  type AuditLog,
  type ExposedPort,
  type ServiceHistoryEntry,
  type ServiceDependency,
  type ContainerImage,
  type ServiceType,
  type TCPCheckConfig,
  type TCPCheckResult,
  type CertCheckConfig,
  type CertCheckResult,
} from '../lib/api';
import { DependencyEditor } from '../components/DependencyEditor';
import { DataPagination } from '@/components/ui/data-pagination';
import { usePagination } from '../hooks/usePagination';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import { useConfirm } from '@/hooks/useConfirm';
import { formatDistanceToNow, format } from 'date-fns';
import { getOverallStatusDotColor, getContainerHealthTextColor } from '../lib/status';
import { safeJsonParse } from '../lib/helpers';
import {
  AlertTriangle,
  ArrowUpCircle,
  CircleAlert,
  Pencil,
  X,
  Eye,
  Box as BoxIcon,
  Rocket,
  RotateCcw,
  CheckCircle2,
  FilePenLine,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

function parseExposedPorts(portsJson: string | null | undefined): ExposedPort[] {
  return safeJsonParse(portsJson, [] as ExposedPort[]);
}

function formatDigestShort(digest: string): string {
  return digest.replace('sha256:', '').substring(0, 12);
}

function parseTCPChecks(jsonStr: string | null): TCPCheckConfig[] {
  return safeJsonParse(jsonStr, [] as TCPCheckConfig[]);
}

function parseTCPCheckResults(jsonStr: string | null | undefined): TCPCheckResult[] {
  return safeJsonParse(jsonStr ?? null, [] as TCPCheckResult[]);
}

function parseCertChecks(jsonStr: string | null | undefined): CertCheckConfig[] {
  return safeJsonParse(jsonStr ?? null, [] as CertCheckConfig[]);
}

function parseCertCheckResults(jsonStr: string | null | undefined): CertCheckResult[] {
  return safeJsonParse(jsonStr ?? null, [] as CertCheckResult[]);
}

export default function ServiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { selectedEnvironment, setBreadcrumbName } = useAppStore();
  const toast = useToast();
  const confirm = useConfirm();
  const [service, setService] = useState<ServiceWithServer | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [logs, setLogs] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsLoadingOlder, setLogsLoadingOlder] = useState(false);
  // Oldest timestamp (ISO) parsed from logs — used as the `before` cursor for "Load older"
  const [oldestLogTimestamp, setOldestLogTimestamp] = useState<string | null>(null);
  // No-more-older indicator (server returned an empty page for the `before` cursor)
  const [noMoreOlderLogs, setNoMoreOlderLogs] = useState(false);
  const logsContainerRef = useRef<HTMLPreElement>(null);
  // How to reposition the logs view after the next `logs` DOM commit. Set right
  // before a setLogs() call and consumed by the layout effect below.
  //  - 'bottom': pin to the newest entry (initial load / refresh)
  //  - { prevHeight, prevTop }: preserve the user's view after prepending older
  //    entries by offsetting scrollTop by the added height
  // A ref + useLayoutEffect is used instead of requestAnimationFrame because the
  // root runs in React concurrent mode: setLogs() from an async handler is
  // committed on a scheduler macrotask that can run *after* a rAF callback, so a
  // rAF read of scrollHeight sees stale content and the scroll misfires.
  const pendingLogScrollRef = useRef<'bottom' | { prevHeight: number; prevTop: number } | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [saving, setSaving] = useState(false);

  // Deploy modal state
  const [showDeployModal, setShowDeployModal] = useState(false);

  // Config edit state
  const [editComposePath, setEditComposePath] = useState<string>('');
  const [editContainerName, setEditContainerName] = useState<string>('');
  const [editHealthCheckUrl, setEditHealthCheckUrl] = useState<string>('');
  const [editTcpChecks, setEditTcpChecks] = useState<TCPCheckConfig[]>([]);
  const [editCertChecks, setEditCertChecks] = useState<CertCheckConfig[]>([]);

  // Attached files state
  const [attachedFiles, setAttachedFiles] = useState<ServiceFile[]>([]);
  const [configFiles, setConfigFiles] = useState<ConfigFile[]>([]);
  const [showAttachFile, setShowAttachFile] = useState(false);
  const [attachConfigFileId, setAttachConfigFileId] = useState('');
  const [attachTargetPath, setAttachTargetPath] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResults, setSyncResults] = useState<SyncResult[] | null>(null);
  // `no_targets` is distinct from `ok` — render as a yellow warning (issue #127).
  const [syncStatus, setSyncStatus] = useState<SyncStatus | undefined>(undefined);
  const [viewingFileContent, setViewingFileContent] = useState<{ name: string; filename: string; content: string } | null>(null);
  const [showCreateFile, setShowCreateFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFileFilename, setNewFileFilename] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [newFileDescription, setNewFileDescription] = useState('');
  const [creatingFile, setCreatingFile] = useState(false);
  const [editingMountPath, setEditingMountPath] = useState<string | null>(null);
  const [editMountPathValue, setEditMountPathValue] = useState('');
  const [savingMountPath, setSavingMountPath] = useState(false);

  // Service types and auto-update state
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>([]);
  const [editServiceTypeId, setEditServiceTypeId] = useState<string>('');
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<{
    hasUpdate: boolean;
    bestTag?: string;
  } | null>(null);

  // Error and health check state
  const [deployError, setDeployError] = useState<string | null>(null);
  const [healthCheckError, setHealthCheckError] = useState<string | null>(null);
  const [healthCheckResult, setHealthCheckResult] = useState<{
    status: string;
    containerStatus: string;
    healthStatus: string;
    container: { state: string; status: string; health?: string; running: boolean };
    url: { success: boolean; statusCode?: number; error?: string } | null;
    exposedPorts: ExposedPort[];
  } | null>(null);
  const [healthCheckHistory, setHealthCheckHistory] = useState<AuditLog[]>([]);
  const [expandedDeployment, setExpandedDeployment] = useState<string | null>(null);

  // Inline name editing state
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Action history state
  const [actionHistory, setActionHistory] = useState<ServiceHistoryEntry[]>([]);
  const [showAllHistory, setShowAllHistory] = useState(false);

  // Orchestration state
  const [dependencies, setDependencies] = useState<ServiceDependency[]>([]);
  const [containerImage, setContainerImage] = useState<ContainerImage | null>(null);

  // Metrics config (for filtering health checks display)
  const [schedulerConfig, setSchedulerConfig] = useState<Record<string, unknown> | null>(null);

  // Pagination hooks (must be at top level)
  const deploymentPagination = usePagination({ data: deployments, defaultPageSize: 10 });
  const healthPagination = usePagination({ data: healthCheckHistory, defaultPageSize: 10 });

  useEffect(() => {
    if (id) {
      setLoading(true);
      Promise.all([
        getService(id).then(({ service }) => {
          setService(service);
          setBreadcrumbName(id, service.name);
          // Load container image if linked
          if (service.containerImageId) {
            getContainerImage(service.containerImageId)
              .then(({ image }) => setContainerImage(image))
              .catch(() => setContainerImage(null));
          }
        }),
        getDeploymentHistory(id, 20).then(({ deployments }) => setDeployments(deployments)),
        listServiceFiles(id).then(({ files }) => setAttachedFiles(files)),
        getAuditLogs({ resourceType: 'service', resourceId: id, action: 'health_check', limit: 10 })
          .then(({ logs }) => setHealthCheckHistory(logs)),
        getServiceHistory(id, 20).then(({ logs }) => setActionHistory(logs)),
        getServiceDependencies(id).then(({ dependencies }) => setDependencies(dependencies)),
      ]).finally(() => setLoading(false));
    }
  }, [id]);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      listConfigFiles(selectedEnvironment.id).then(({ configFiles }) =>
        setConfigFiles(configFiles)
      );
      // Load monitoring settings for metrics/health check toggles
      getModuleSettings(selectedEnvironment.id, 'monitoring')
        .then(({ settings }) => setSchedulerConfig(settings))
        .catch(() => setSchedulerConfig(null));
    }
    // Load service types (global, not per-environment)
    listServiceTypes().then(({ serviceTypes }) =>
      setServiceTypes(serviceTypes)
    );
  }, [selectedEnvironment?.id]);

  const handleCheckUpdates = async () => {
    if (!id) return;
    setCheckingUpdates(true);
    setUpdateCheckResult(null);
    try {
      const result = await checkServiceUpdates(id);
      setUpdateCheckResult({
        hasUpdate: result.hasUpdate,
        bestTag: result.bestTag,
      });
      // Update the service state with new values
      if (service) {
        setService({
          ...service,
          latestAvailableTag: result.bestTag || service.latestAvailableTag,
          lastUpdateCheckAt: result.lastUpdateCheckAt || service.lastUpdateCheckAt,
        });
      }
    } catch (error) {
      console.error('Update check failed:', error);
    } finally {
      setCheckingUpdates(false);
    }
  };

  const startEditingName = () => {
    if (service) {
      setEditName(service.name);
      setEditingName(true);
      setTimeout(() => nameInputRef.current?.focus(), 0);
    }
  };

  const cancelEditingName = () => {
    setEditingName(false);
    setEditName('');
  };

  const saveEditName = async () => {
    if (!id || !service || !editName.trim() || editName === service.name) {
      cancelEditingName();
      return;
    }
    setSavingName(true);
    try {
      const { service: updated } = await updateService(id, { name: editName.trim() });
      setService((prev) => (prev ? { ...prev, name: updated.name } : null));
      setBreadcrumbName(id, updated.name);
      setEditingName(false);
      toast.success('Service name updated');
    } catch (error) {
      toast.error('Failed to update service name');
    } finally {
      setSavingName(false);
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEditName();
    } else if (e.key === 'Escape') {
      cancelEditingName();
    }
  };

  const refreshDependencies = async () => {
    if (!id) return;
    const { dependencies } = await getServiceDependencies(id);
    setDependencies(dependencies);
  };

  const handleDeploy = async (tag?: string) => {
    if (!id) return;
    const deployTag = tag || containerImage?.latestDigest?.bestTag || containerImage?.latestDigest?.tags?.[0] || service?.imageTag || 'latest';
    setDeploying(true);
    setDeployError(null);
    setShowDeployModal(false);
    try {
      const outcome = await deployService(id, { imageTag: deployTag, pullImage: true });
      // outcome.results is an array of per-deployment results in 2.0. Show whichever ran.
      const newDeployments = outcome.results
        .map((r) => r.result?.deployment)
        .filter((d): d is NonNullable<typeof d> => Boolean(d));
      if (newDeployments.length > 0) {
        setDeployments((prev) => [...newDeployments, ...prev]);
      }
      if (service) {
        setService({ ...service, imageTag: deployTag });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deployment failed';
      setDeployError(message);
      getDeploymentHistory(id, 20).then(({ deployments }) => setDeployments(deployments));
    } finally {
      setDeploying(false);
    }
  };

  const handleRestart = async () => {
    if (!id) return;
    setRestarting(true);
    try {
      await restartService(id);
      // Refetch the service so container ID, uptime, and status reflect the
      // freshly recreated container (compose-managed services get a new
      // container on restart, not just a bounce of the old one).
      const [{ service: refreshed }, { logs: history }] = await Promise.all([
        getService(id),
        getServiceHistory(id, 20),
      ]);
      setService(refreshed);
      setActionHistory(history);
    } finally {
      setRestarting(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !service) return;
    if (
      !(await confirm({
        title: 'Delete service',
        description: `Are you sure you want to delete the service "${service.name}"? This cannot be undone.`,
        confirmText: 'Delete',
        destructive: true,
      }))
    )
      return;
    setDeleting(true);
    try {
      await deleteService(id);
      const targetServerId =
        service.server?.id ?? service.serviceDeployments?.[0]?.serverId ?? null;
      navigate(targetServerId ? `/servers/${targetServerId}` : `/services`);
    } finally {
      setDeleting(false);
    }
  };

  const handleHealthCheck = async () => {
    if (!id) return;
    setChecking(true);
    setHealthCheckError(null);
    setHealthCheckResult(null);
    try {
      const result = await checkServiceHealth(id);
      setService((prev) =>
        prev ? {
          ...prev,
          status: result.status,
          containerStatus: result.containerStatus,
          healthStatus: result.healthStatus,
          exposedPorts: JSON.stringify(result.exposedPorts),
          imageTag: result.imageTag,
          lastCheckedAt: result.lastCheckedAt,
        } : null
      );
      setHealthCheckResult({
        status: result.status,
        containerStatus: result.containerStatus,
        healthStatus: result.healthStatus,
        container: result.container,
        url: result.url,
        exposedPorts: result.exposedPorts,
      });
      // Refresh health check history and action history
      Promise.all([
        getAuditLogs({ resourceType: 'service', resourceId: id, action: 'health_check', limit: 10 })
          .then(({ logs }) => setHealthCheckHistory(logs)),
        getServiceHistory(id, 20).then(({ logs }) => setActionHistory(logs)),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Health check failed';
      setHealthCheckError(message);
      // Still refresh history to show the failed attempt
      Promise.all([
        getAuditLogs({ resourceType: 'service', resourceId: id, action: 'health_check', limit: 10 })
          .then(({ logs }) => setHealthCheckHistory(logs)),
        getServiceHistory(id, 20).then(({ logs }) => setActionHistory(logs)),
      ]);
    } finally {
      setChecking(false);
    }
  };

  // Extract the first ISO-8601 timestamp from a `docker logs -t` line.
  // Format example: "2026-05-25T10:23:45.123456789Z message ..."
  const extractOldestTimestamp = (text: string): string | null => {
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
      if (match) return match[1];
    }
    return null;
  };

  // Reposition the logs view after each `logs` change, once the new content is
  // committed to the DOM. Runs before paint so the user never sees a flash at
  // the wrong scroll position. See pendingLogScrollRef for why this isn't rAF.
  useLayoutEffect(() => {
    const intent = pendingLogScrollRef.current;
    if (!intent) return;
    pendingLogScrollRef.current = null;
    const container = logsContainerRef.current;
    if (!container) return;
    if (intent === 'bottom') {
      // Pin to the newest entry (logs render oldest->newest, like `docker logs`).
      container.scrollTop = container.scrollHeight;
    } else {
      // Older entries were prepended: keep the previously-visible lines in place
      // by offsetting scrollTop by the height that was added at the top.
      const delta = container.scrollHeight - intent.prevHeight;
      container.scrollTop = intent.prevTop + delta;
    }
  }, [logs]);

  const loadLogs = async () => {
    if (!id) return;
    setLogsLoading(true);
    setShowLogs(true);
    setNoMoreOlderLogs(false);
    setOldestLogTimestamp(null);
    try {
      // tail omitted -> server uses admin-configured defaultLogLines
      const { logs } = await getServiceLogs(id);
      // Pin the view to the most recent entries once this content commits.
      // Without this the modal opens scrolled to the top, hiding newer logs.
      pendingLogScrollRef.current = 'bottom';
      setLogs(logs);
      setOldestLogTimestamp(extractOldestTimestamp(logs));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load logs';
      if (message.includes('No such container')) {
        setLogs('Container not found. The service may not be running or has not been deployed yet.');
      } else {
        toast.error(message);
        setShowLogs(false);
        // Clear any previous log content so a future re-open doesn't show
        // stale text with the Load Older button permanently disabled.
        setLogs('');
      }
    } finally {
      setLogsLoading(false);
    }
  };

  const loadOlderLogs = async () => {
    if (!id || !oldestLogTimestamp || logsLoadingOlder) return;
    setLogsLoadingOlder(true);
    try {
      // Use the oldest visible timestamp as the `before` cursor. Server returns
      // up to defaultLogLines older lines ending at that timestamp.
      const { logs: older } = await getServiceLogs(id, { before: oldestLogTimestamp });
      const trimmed = older.trim();
      if (!trimmed) {
        setNoMoreOlderLogs(true);
        return;
      }
      const newOldest = extractOldestTimestamp(older);
      if (!newOldest) {
        // Can't parse a timestamp from the older chunk -> cannot advance the
        // cursor safely. Mark pagination as exhausted to avoid re-fetching the
        // same payload on subsequent clicks.
        setNoMoreOlderLogs(true);
        return;
      }
      if (newOldest === oldestLogTimestamp) {
        // Server clipped at the same boundary — nothing new to fetch
        setNoMoreOlderLogs(true);
        return;
      }
      // docker --until is inclusive, so the boundary line (the previous oldest
      // log timestamp) appears in both pages. Drop leading lines whose
      // timestamp equals the prior cursor to avoid visible duplicates.
      const olderLines = trimmed.split('\n');
      let dropIdx = 0;
      while (dropIdx < olderLines.length) {
        const m = olderLines[dropIdx].match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
        if (m && m[1] === oldestLogTimestamp) {
          dropIdx++;
        } else {
          break;
        }
      }
      const dedupedTrimmed = olderLines.slice(dropIdx).join('\n');
      if (!dedupedTrimmed) {
        // The entire older chunk was the boundary line — nothing new to add.
        setOldestLogTimestamp(newOldest);
        return;
      }
      // Preserve scroll position when prepending older content. The layout
      // effect restores the user's view once the new content is committed.
      const container = logsContainerRef.current;
      pendingLogScrollRef.current = {
        prevHeight: container?.scrollHeight ?? 0,
        prevTop: container?.scrollTop ?? 0,
      };
      setLogs((prev) => `${dedupedTrimmed}\n${prev}`);
      setOldestLogTimestamp(newOldest);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load older logs';
      toast.error(message);
    } finally {
      setLogsLoadingOlder(false);
    }
  };

  const openConfig = () => {
    if (!service) return;
    setEditComposePath(service.composePath || '');
    setEditContainerName(service.containerName || '');
    setEditHealthCheckUrl(service.healthCheckUrl || '');
    setEditServiceTypeId(service.serviceTypeId || '');
    setEditTcpChecks(parseTCPChecks(service.tcpChecks));
    setEditCertChecks(parseCertChecks(service.certChecks));
    setShowConfig(true);
  };

  const saveConfig = async () => {
    if (!id || !selectedEnvironment?.id) return;
    setSaving(true);
    try {
      const { service: updated } = await updateService(id, {
        composePath: editComposePath || null,
        containerName: editContainerName || undefined,
        healthCheckUrl: editHealthCheckUrl || null,
        serviceTypeId: editServiceTypeId || null,
        tcpChecks: editTcpChecks.length > 0 ? JSON.stringify(editTcpChecks) : null,
        certChecks: editCertChecks.length > 0 ? JSON.stringify(editCertChecks) : null,
      });
      setService((prev) => {
        if (!prev) return null;
        // The PATCH endpoint returns the bare Service template (no deployments
        // joined); preserve the existing serviceDeployments so the runtime/server
        // panels keep rendering.
        return { ...prev, ...updated, serviceDeployments: prev.serviceDeployments };
      });
      setShowConfig(false);
      toast.success('Configuration saved');
    } finally {
      setSaving(false);
    }
  };

  const handleAttachFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setAttaching(true);
    try {
      const { serviceFile } = await attachServiceFile(id, {
        configFileId: attachConfigFileId,
        targetPath: attachTargetPath,
      });
      setAttachedFiles((prev) => [...prev, serviceFile]);
      setShowAttachFile(false);
      setAttachConfigFileId('');
      setAttachTargetPath('');
    } finally {
      setAttaching(false);
    }
  };

  const handleDetachFile = async (configFileId: string) => {
    if (!id) return;
    if (
      !(await confirm({
        title: 'Detach file',
        description: 'Detach this file from the service?',
        confirmText: 'Detach',
        destructive: true,
      }))
    )
      return;
    await detachServiceFile(id, configFileId);
    setAttachedFiles((prev) => prev.filter((f) => f.configFileId !== configFileId));
  };

  const startEditMountPath = (configFileId: string, currentPath: string) => {
    setEditingMountPath(configFileId);
    setEditMountPathValue(currentPath);
  };

  const cancelEditMountPath = () => {
    setEditingMountPath(null);
    setEditMountPathValue('');
  };

  const saveMountPath = async (configFileId: string) => {
    if (!id || !editMountPathValue.trim()) {
      cancelEditMountPath();
      return;
    }
    setSavingMountPath(true);
    try {
      const { serviceFile } = await updateServiceFile(id, configFileId, editMountPathValue.trim());
      setAttachedFiles((prev) =>
        prev.map((f) => (f.configFileId === configFileId ? serviceFile : f))
      );
      setEditingMountPath(null);
      toast.success('Mount path updated');
    } catch {
      toast.error('Failed to update mount path');
    } finally {
      setSavingMountPath(false);
    }
  };

  const handleMountPathKeyDown = (e: React.KeyboardEvent, configFileId: string) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveMountPath(configFileId);
    } else if (e.key === 'Escape') {
      cancelEditMountPath();
    }
  };

  const handleSyncFiles = async () => {
    if (!id) return;
    setSyncing(true);
    setSyncResults(null);
    setSyncStatus(undefined);
    try {
      const { results, status } = await syncServiceFiles(id);
      setSyncResults(results);
      setSyncStatus(status);
    } finally {
      setSyncing(false);
    }
  };

  const openAttachFile = () => {
    setAttachConfigFileId('');
    setAttachTargetPath('');
    setShowAttachFile(true);
  };

  const handleViewFileContent = async (fileId: string, fileName: string, filename: string) => {
    try {
      const { configFile } = await getConfigFile(fileId);
      setViewingFileContent({ name: fileName, filename, content: configFile.content || '' });
    } catch {
      toast.error('Failed to load file content');
    }
  };

  const handleCreateNewFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;
    setCreatingFile(true);
    try {
      const { configFile } = await createConfigFile(selectedEnvironment.id, {
        name: newFileName,
        filename: newFileFilename,
        content: newFileContent,
        description: newFileDescription || undefined,
      });
      // Add to configFiles list and select it
      setConfigFiles((prev) => [...prev, configFile]);
      setAttachConfigFileId(configFile.id);
      // Auto-suggest target path
      const serviceName = service?.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'app';
      const defaultPath = service?.composePath
        ? service.composePath.replace(/[^/]+$/, configFile.filename)
        : `/opt/${serviceName}/${configFile.filename}`;
      setAttachTargetPath(defaultPath);
      // Close create modal, keep attach modal open
      setShowCreateFile(false);
      setNewFileName('');
      setNewFileFilename('');
      setNewFileContent('');
      setNewFileDescription('');
      toast.success('Config file created');
    } catch (error) {
      toast.error('Failed to create config file');
    } finally {
      setCreatingFile(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 space-y-5">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!service) {
    return (
      <div className="p-6">
        <Card className="text-center py-12">
          <p className="text-muted-foreground">Service not found</p>
          <Button asChild className="mt-4 mx-auto">
            <Link to="/services">Back to Services</Link>
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Missing Service Warning */}
      {service.discoveryStatus === 'missing' && (
        <Alert className="mb-5 border-orange-500/30 bg-orange-500/10 text-orange-300">
          <AlertTriangle className="size-5 text-orange-400" />
          <AlertTitle className="text-orange-400">Container Not Found</AlertTitle>
          <AlertDescription className="text-orange-300/80">
            This container was not found during the last discovery. It may have been stopped, removed, or crashed.
            {service.lastDiscoveredAt && (
              <> Last seen {formatDistanceToNow(new Date(service.lastDiscoveredAt), { addSuffix: true })}.</>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-3">
            {/* Container Status Badge */}
            <StatusBadge kind="container" value={service.containerStatus || service.status || 'unknown'} />
            {/* Health Status Badge */}
            <StatusBadge kind="health" value={service.healthStatus || 'unknown'} />
            {/* Inline Editable Name */}
            {editingName ? (
              <div className="flex items-center gap-2">
                <Input
                  ref={nameInputRef}
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={handleNameKeyDown}
                  onBlur={saveEditName}
                  disabled={savingName}
                  className="text-xl font-bold h-auto py-0.5"
                  style={{ minWidth: '200px' }}
                />
                {savingName && (
                  <span className="text-sm text-muted-foreground">Saving...</span>
                )}
              </div>
            ) : (
              <span
                className="text-xl font-bold text-foreground cursor-pointer hover:text-primary group flex items-center gap-2"
                onClick={startEditingName}
                title="Click to edit service name"
              >
                {service.name}
                <Pencil className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-1">
            {service.server ? (
              <>
                on{' '}
                <Link
                  to={`/servers/${service.server.id}`}
                  className="text-primary hover:underline"
                >
                  {service.server.name}
                </Link>
                {service.environment?.name && (
                  <>
                    {' • '}
                    {service.environment.name}
                  </>
                )}
              </>
            ) : service.serviceDeployments && service.serviceDeployments.length > 0 ? (
              <>
                {service.serviceDeployments.length} deployment{service.serviceDeployments.length === 1 ? '' : 's'}
                {service.environment?.name && (
                  <>
                    {' • '}
                    {service.environment.name}
                  </>
                )}
              </>
            ) : (
              <>No deployments{service.environment?.name && <> • {service.environment.name}</>}</>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={loadLogs}>
            View Logs
          </Button>
          <Button variant="ghost" onClick={handleHealthCheck} disabled={checking}>
            {checking ? 'Checking...' : 'Health Check'}
          </Button>
          <Button variant="secondary" onClick={handleRestart} disabled={restarting}>
            {restarting ? 'Restarting...' : 'Restart'}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </div>

      {/* Update Available Banner */}
      {service.latestAvailableTag && service.latestAvailableTag !== service.imageTag && (
        <Alert className="mb-5 border-blue-500/30 bg-blue-500/10 text-blue-300">
          <ArrowUpCircle className="size-5 text-blue-400" />
          <AlertTitle className="text-blue-400">Update Available</AlertTitle>
          <AlertDescription className="text-blue-300/80">
            New version <code className="bg-blue-500/20 px-1 rounded">{service.latestAvailableTag}</code> is available
            (current: {service.imageTag})
          </AlertDescription>
          <div className="col-start-2 mt-2">
            <Button
              onClick={() => handleDeploy(service.latestAvailableTag!)}
              disabled={deploying}
            >
              {deploying ? 'Deploying...' : 'Deploy Update'}
            </Button>
          </div>
        </Alert>
      )}

      <div className="grid grid-cols-3 gap-4 mb-5">
        {/* Deploy Card */}
        <Card className="col-span-2 p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-foreground">Deploy</h3>
            {containerImage?.registryConnectionId && (
              <Button variant="ghost" size="sm" onClick={handleCheckUpdates} disabled={checkingUpdates}>
                {checkingUpdates ? 'Checking...' : 'Check for Updates'}
              </Button>
            )}
          </div>
          <div className="space-y-4">
            {/* Image info - read from containerImage */}
            <div className="grid grid-cols-2 gap-4 p-3 bg-muted/50 rounded-lg">
              <div>
                <dt className="text-xs text-muted-foreground uppercase tracking-wide">Image Name</dt>
                <dd className="text-foreground font-mono text-sm mt-0.5">
                  {containerImage ? (
                    <Link to={`/container-images/${containerImage.id}`} className="text-primary hover:underline">
                      {containerImage.imageName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground italic">Not linked to container image</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground uppercase tracking-wide">Image Tag</dt>
                <dd className="mt-0.5 flex flex-wrap gap-1">
                  {(() => {
                    const tags = containerImage?.deployedDigest?.tags || containerImage?.latestDigest?.tags;
                    if (tags && tags.length > 0) {
                      return tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="font-mono">
                          {tag}
                        </Badge>
                      ));
                    }
                    return service.imageTag ? (
                      <Badge variant="secondary" className="font-mono">
                        {service.imageTag}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground italic text-sm">Not set</span>
                    );
                  })()}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground uppercase tracking-wide">Registry</dt>
                <dd className="text-foreground text-sm mt-0.5">
                  {containerImage?.registryConnection ? (
                    <Link to="/registries" className="text-primary hover:underline">
                      {containerImage.registryConnection.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground italic">Not linked</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground uppercase tracking-wide">Last Updated</dt>
                <dd className="text-foreground text-sm mt-0.5">
                  {service.updatedAt ? (
                    formatDistanceToNow(new Date(service.updatedAt), { addSuffix: true })
                  ) : (
                    <span className="text-muted-foreground italic">Unknown</span>
                  )}
                </dd>
              </div>
            </div>

            <Button onClick={() => setShowDeployModal(true)} disabled={deploying} className="w-full">
              {deploying ? 'Deploying...' : 'Deploy'}
            </Button>

            {/* Last update check */}
            {service.lastUpdateCheckAt && (
              <p className="text-xs text-muted-foreground">
                Last checked {formatDistanceToNow(new Date(service.lastUpdateCheckAt), { addSuffix: true })}
              </p>
            )}

            {/* Update check result */}
            {updateCheckResult && (
              <div className={cn('text-sm', updateCheckResult.hasUpdate ? 'text-blue-400' : 'text-green-400')}>
                {updateCheckResult.hasUpdate
                  ? `Update available: ${updateCheckResult.bestTag || 'new digest'}`
                  : 'No updates available'}
              </div>
            )}

            {/* Deploy error */}
            {deployError && (
              <Alert variant="destructive">
                <CircleAlert className="size-5" />
                <AlertTitle>Deployment Failed</AlertTitle>
                <AlertDescription>{deployError}</AlertDescription>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setDeployError(null)}
                  className="absolute top-2 right-2"
                  aria-label="Dismiss"
                >
                  <X className="size-4" />
                </Button>
              </Alert>
            )}
          </div>
        </Card>

        {/* Service Info */}
        <Card className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-foreground">Details</h3>
            <Button variant="ghost" size="sm" onClick={openConfig}>
              Configure
            </Button>
          </div>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Container</dt>
              <dd className="text-foreground font-mono">{service.containerName}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Type</dt>
              <dd className="text-foreground">{service.serviceType?.displayName || 'Generic'}</dd>
            </div>
            {/* Exposed Ports */}
            <div>
              <dt className="text-muted-foreground">Ports</dt>
              <dd className="text-foreground">
                {(() => {
                  const ports = parseExposedPorts(service.exposedPorts);
                  if (ports.length === 0) {
                    return <span className="text-muted-foreground">No ports exposed</span>;
                  }
                  return (
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {ports.map((port, i) => (
                        <Badge
                          key={i}
                          variant="secondary"
                          className="font-mono"
                          title={`${port.protocol.toUpperCase()}`}
                        >
                          {port.host ? `${port.host}:${port.container}` : port.container}
                        </Badge>
                      ))}
                    </div>
                  );
                })()}
              </dd>
            </div>
            {service.composePath && (
              <div>
                <dt className="text-muted-foreground">Compose Path</dt>
                <dd className="text-foreground font-mono text-xs">
                  {service.composePath}
                </dd>
              </div>
            )}
            {service.healthCheckUrl && (
              <div>
                <dt className="text-muted-foreground">Health Check URL</dt>
                <dd className="text-foreground font-mono text-xs">
                  {service.healthCheckUrl}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">Last Checked</dt>
              <dd className="text-foreground">
                {service.lastCheckedAt
                  ? formatDistanceToNow(new Date(service.lastCheckedAt), {
                      addSuffix: true,
                    })
                  : 'Never'}
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      {/* Orchestration Row: Dependencies & Health Config */}
      <div className="grid grid-cols-2 gap-4 mb-5">
        {/* Dependencies Card */}
        <Card className="p-4">
          <h3 className="text-lg font-semibold text-foreground mb-4">Dependencies</h3>
          <DependencyEditor serviceId={id!} onUpdate={refreshDependencies} />
          {dependencies.length > 0 && (
            <div className="mt-4 pt-4 border-t">
              <p className="text-xs text-muted-foreground mb-2">Current Dependencies</p>
              <div className="space-y-2">
                {dependencies.map((dep) => (
                  <div
                    key={dep.id}
                    className="flex items-center justify-between p-2 bg-muted/50 rounded"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={dep.type === 'health_before' ? 'success' : 'info'}>
                        {dep.type === 'health_before' ? 'waits for healthy' : 'deploys after'}
                      </Badge>
                      <Link
                        to={`/services/${dep.dependsOn.id}`}
                        className="text-primary hover:underline"
                      >
                        {dep.dependsOn.name}
                      </Link>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      on {dep.dependsOn.server?.name}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {containerImage && (
            <div className="mt-4 pt-4 border-t">
              <p className="text-xs text-muted-foreground mb-2">Container Image</p>
              <Link
                to="/container-images"
                className="flex items-center gap-2 p-2 bg-primary/10 border border-primary/30 rounded hover:bg-primary/20"
              >
                <BoxIcon className="size-4 text-primary" />
                <span className="text-foreground font-medium">{containerImage.name}</span>
                <span className="text-xs text-primary font-mono ml-auto">
                  :{containerImage.bestTag || containerImage.tagFilter}
                </span>
              </Link>
            </div>
          )}
        </Card>

        {/* Config Files Card */}
        <Card className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-foreground">Config Files</h3>
            <div className="flex gap-2">
              {attachedFiles.length > 0 && (
                <Button variant="secondary" size="sm" onClick={handleSyncFiles} disabled={syncing}>
                  {syncing ? 'Syncing...' : 'Sync'}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={openAttachFile}>
                Attach
              </Button>
            </div>
          </div>

          {/* Sync Results */}
          {syncResults && (
            <div
              className={cn(
                'mb-4 p-3 rounded-lg border',
                syncStatus === 'no_targets'
                  ? 'bg-yellow-500/10 border-yellow-500/30'
                  : 'bg-muted/50 border-border'
              )}
            >
              {syncStatus === 'no_targets' ? (
                // 200 OK + no_targets → yellow warning, NOT a green success.
                // Sync ran but found nothing to write — surface the gap to the
                // operator (issue #127).
                <p className="text-sm text-yellow-400">
                  This service has no files attached, or no deployments to sync to — sync did nothing.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground mb-2">Sync Results:</p>
                  <div className="space-y-1">
                    {syncResults.map((result, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        {result.success ? (
                          <CheckCircle2 className="size-4 text-green-400" />
                        ) : (
                          <X className="size-4 text-red-400" />
                        )}
                        <span className="text-foreground">{result.file}</span>
                        <span className="text-muted-foreground">→</span>
                        <code className="text-muted-foreground text-xs">{result.targetPath}</code>
                        {result.error && (
                          <span className="text-red-400 text-xs">({result.error})</span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setSyncResults(null);
                  setSyncStatus(undefined);
                }}
                className="mt-2"
              >
                Dismiss
              </Button>
            </div>
          )}

          {attachedFiles.length > 0 ? (
            <div className="space-y-2">
              {attachedFiles.map((file) => (
                <div
                  key={file.id}
                  className="flex items-center justify-between p-2 bg-muted/50 rounded-lg"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground text-sm">{file.configFile.name}</span>
                      {file.configFile.isBinary && (
                        <Badge variant="secondary" className="bg-purple-900/30 text-purple-400">
                          bin
                        </Badge>
                      )}
                    </div>
                    {editingMountPath === file.configFileId ? (
                      <div className="flex items-center gap-2 mt-1">
                        <Input
                          type="text"
                          value={editMountPathValue}
                          onChange={(e) => setEditMountPathValue(e.target.value)}
                          onKeyDown={(e) => handleMountPathKeyDown(e, file.configFileId)}
                          onBlur={() => saveMountPath(file.configFileId)}
                          disabled={savingMountPath}
                          autoFocus
                          className="flex-1 h-7 text-green-400 font-mono text-xs"
                        />
                      </div>
                    ) : (
                      <button
                        className="flex items-center gap-1 group mt-1"
                        onClick={() => startEditMountPath(file.configFileId, file.targetPath)}
                        title="Click to edit path"
                      >
                        <code className="text-xs text-green-400 group-hover:text-green-300">
                          {file.targetPath}
                        </code>
                        <Pencil className="size-3 text-muted-foreground group-hover:text-foreground" />
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {!file.configFile.isBinary && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => handleViewFileContent(file.configFileId, file.configFile.name, file.configFile.filename)}
                        title="View"
                      >
                        <Eye className="size-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleDetachFile(file.configFileId)}
                      className="text-muted-foreground hover:text-destructive"
                      title="Detach"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No config files attached.
            </p>
          )}
        </Card>
      </div>

      {/* Health Check Result/Error */}
      {(healthCheckError || healthCheckResult) && (
        <Card className="p-4 mb-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-foreground">Health Check Result</h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setHealthCheckError(null);
                setHealthCheckResult(null);
              }}
            >
              Dismiss
            </Button>
          </div>

          {healthCheckError && (
            <Alert variant="destructive">
              <CircleAlert className="size-5" />
              <AlertTitle>Health Check Failed</AlertTitle>
              <AlertDescription>{healthCheckError}</AlertDescription>
            </Alert>
          )}

          {healthCheckResult && (
            <div className="space-y-4">
              {/* Overall Status */}
              <div className="flex items-center gap-3">
                <span className={cn('size-3 rounded-full', getOverallStatusDotColor(healthCheckResult.status))} />
                <span className="text-foreground font-medium capitalize">{healthCheckResult.status}</span>
              </div>

              {/* Container Details */}
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground text-sm mb-2">Container</p>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">State</dt>
                    <dd className="text-foreground">{healthCheckResult.container.state}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Status</dt>
                    <dd className="text-foreground">{healthCheckResult.container.status}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Running</dt>
                    <dd className={healthCheckResult.container.running ? 'text-green-400' : 'text-red-400'}>
                      {healthCheckResult.container.running ? 'Yes' : 'No'}
                    </dd>
                  </div>
                  {healthCheckResult.container.health && (
                    <div>
                      <dt className="text-muted-foreground">Health</dt>
                      <dd className={getContainerHealthTextColor(healthCheckResult.container.health)}>
                        {healthCheckResult.container.health}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>

              {/* URL Check Details */}
              {healthCheckResult.url && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-muted-foreground text-sm mb-2">URL Health Check</p>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-muted-foreground">Status</dt>
                      <dd className={healthCheckResult.url.success ? 'text-green-400' : 'text-red-400'}>
                        {healthCheckResult.url.success ? 'Success' : 'Failed'}
                      </dd>
                    </div>
                    {healthCheckResult.url.statusCode && (
                      <div>
                        <dt className="text-muted-foreground">HTTP Code</dt>
                        <dd className="text-foreground">{healthCheckResult.url.statusCode}</dd>
                      </div>
                    )}
                    {healthCheckResult.url.error && (
                      <div className="col-span-2">
                        <dt className="text-muted-foreground">Error</dt>
                        <dd className="text-red-400 text-xs">{healthCheckResult.url.error}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Agent Health Check Results (TCP & Cert) */}
      {service && (
        ((schedulerConfig?.collectTcpChecks ?? true) && parseTCPCheckResults(service.agentTcpCheckResults).length > 0) ||
        ((schedulerConfig?.collectCertChecks ?? true) && parseCertCheckResults(service.agentCertCheckResults).length > 0)
      ) && (
        <div className="grid grid-cols-2 gap-4 mb-5">
          {/* TCP Check Results */}
          {(schedulerConfig?.collectTcpChecks ?? true) && parseTCPCheckResults(service.agentTcpCheckResults).length > 0 && (
            <Card className="p-4">
              <h3 className="text-lg font-semibold text-foreground mb-4">
                TCP Port Checks
                {service.agentTcpCheckedAt && (
                  <span className="text-xs text-muted-foreground font-normal ml-2">
                    {formatDistanceToNow(new Date(service.agentTcpCheckedAt), { addSuffix: true })}
                  </span>
                )}
              </h3>
              <div className="space-y-2">
                {parseTCPCheckResults(service.agentTcpCheckResults).map((result, i) => (
                  <div
                    key={i}
                    className={cn(
                      'flex items-center justify-between p-2 rounded-lg',
                      result.success ? 'bg-green-500/10' : 'bg-red-500/10'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn('size-2 rounded-full', result.success ? 'bg-green-400' : 'bg-red-400')} />
                      <span className="text-foreground font-mono text-sm">
                        {result.host}:{result.port}
                      </span>
                      {result.name && (
                        <span className="text-muted-foreground text-xs">({result.name})</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{result.durationMs}ms</span>
                      {result.error && (
                        <span className="text-xs text-red-400" title={result.error}>error</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Certificate Check Results */}
          {(schedulerConfig?.collectCertChecks ?? true) && parseCertCheckResults(service.agentCertCheckResults).length > 0 && (
            <Card className="p-4">
              <h3 className="text-lg font-semibold text-foreground mb-4">
                Certificate Expiry
                {service.agentCertCheckedAt && (
                  <span className="text-xs text-muted-foreground font-normal ml-2">
                    {formatDistanceToNow(new Date(service.agentCertCheckedAt), { addSuffix: true })}
                  </span>
                )}
              </h3>
              <div className="space-y-2">
                {parseCertCheckResults(service.agentCertCheckResults).map((result, i) => (
                  <div
                    key={i}
                    className={cn(
                      'p-3 rounded-lg',
                      result.success
                        ? result.daysUntilExpiry !== undefined && result.daysUntilExpiry < 30
                          ? 'bg-yellow-500/10'
                          : 'bg-green-500/10'
                        : 'bg-red-500/10'
                    )}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          'size-2 rounded-full',
                          result.success
                            ? result.daysUntilExpiry !== undefined && result.daysUntilExpiry < 30
                              ? 'bg-yellow-400'
                              : 'bg-green-400'
                            : 'bg-red-400'
                        )} />
                        <span className="text-foreground font-mono text-sm">
                          {result.host}:{result.port}
                        </span>
                        {result.name && (
                          <span className="text-muted-foreground text-xs">({result.name})</span>
                        )}
                      </div>
                      {result.daysUntilExpiry !== undefined && (
                        <span className={cn(
                          'text-sm font-medium',
                          result.daysUntilExpiry < 0
                            ? 'text-red-400'
                            : result.daysUntilExpiry < 30
                            ? 'text-yellow-400'
                            : 'text-green-400'
                        )}>
                          {result.daysUntilExpiry < 0
                            ? 'Expired'
                            : `${result.daysUntilExpiry} days`}
                        </span>
                      )}
                    </div>
                    {result.success && (
                      <div className="text-xs text-muted-foreground space-y-0.5">
                        {result.subject && <div>Subject: {result.subject}</div>}
                        {result.issuer && <div>Issuer: {result.issuer}</div>}
                        {result.expiresAt && (
                          <div>Expires: {format(new Date(result.expiresAt), 'MMM d, yyyy')}</div>
                        )}
                      </div>
                    )}
                    {result.error && (
                      <div className="text-xs text-red-400 mt-1">{result.error}</div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Servers */}
      {service.serviceDeployments && service.serviceDeployments.length > 0 && (
        <Card className="p-4">
          <h3 className="text-lg font-semibold text-foreground mb-4">Servers</h3>
          <div className="flex flex-wrap gap-2">
            {service.serviceDeployments.map((dep) => (
              <Badge key={dep.id} variant="secondary" asChild>
                <Link to={`/servers/${dep.server.id}`} className="text-primary hover:underline">
                  {dep.server.name}
                </Link>
              </Badge>
            ))}
          </div>
        </Card>
      )}

      {/* Deployment History */}
      <Card className="p-4">
        <h3 className="text-lg font-semibold text-foreground mb-4">
          Deployment History
        </h3>
        {deployments.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tag</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Server</TableHead>
                    <TableHead>Triggered By</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deploymentPagination.paginatedData.map((deployment) => (
                    <Fragment key={deployment.id}>
                      <TableRow>
                        <TableCell className="font-mono text-primary">
                          {deployment.imageTag}
                        </TableCell>
                        <TableCell>
                          <StatusBadge kind="deployment" value={deployment.status} />
                        </TableCell>
                        <TableCell>
                          {deployment.serviceDeployment?.server ? (
                            <Link
                              to={`/servers/${deployment.serviceDeployment.server.id}`}
                              className="text-primary hover:underline"
                            >
                              {deployment.serviceDeployment.server.name}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>{deployment.triggeredBy}</TableCell>
                        <TableCell className="text-sm">
                          {format(new Date(deployment.startedAt), 'MMM d, HH:mm')}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {deployment.completedAt
                            ? `${Math.round(
                                (new Date(deployment.completedAt).getTime() -
                                  new Date(deployment.startedAt).getTime()) /
                                  1000
                              )}s`
                            : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          {deployment.logs && (
                            <Button
                              variant="link"
                              size="sm"
                              onClick={() =>
                                setExpandedDeployment(
                                  expandedDeployment === deployment.id ? null : deployment.id
                                )
                              }
                              className={cn(
                                'h-auto p-0',
                                deployment.status === 'failed'
                                  ? 'text-red-400 hover:text-red-300'
                                  : 'text-muted-foreground hover:text-foreground'
                              )}
                            >
                              {expandedDeployment === deployment.id ? 'Hide Logs' : 'View Logs'}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                      {expandedDeployment === deployment.id && deployment.logs && (
                        <TableRow>
                          <TableCell colSpan={7} className="p-0">
                            <pre className="p-4 bg-background text-xs text-foreground font-mono overflow-x-auto max-h-64 overflow-y-auto">
                              {deployment.logs}
                            </pre>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
            {deploymentPagination.totalPages > 1 && (
              <div className="mt-4">
                <DataPagination
                  currentPage={deploymentPagination.currentPage}
                  totalPages={deploymentPagination.totalPages}
                  totalItems={deploymentPagination.totalItems}
                  pageSize={deploymentPagination.pageSize}
                  onPageChange={deploymentPagination.setPage}
                  onPageSizeChange={deploymentPagination.setPageSize}
                  pageSizeOptions={[10, 25, 50]}
                />
              </div>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">No deployments yet</p>
        )}
      </Card>

      {/* Health Check History */}
      <Card className="p-4 mt-5">
        <h3 className="text-lg font-semibold text-foreground mb-4">
          Health Check History
        </h3>
        {healthCheckHistory.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Container</TableHead>
                    <TableHead>URL Check</TableHead>
                    <TableHead>User</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {healthPagination.paginatedData.map((log) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const details = safeJsonParse<Record<string, any> | null>(log.details, null);
                    return (
                      <TableRow key={log.id}>
                        <TableCell className="text-sm">
                          {format(new Date(log.createdAt), 'MMM d, HH:mm:ss')}
                        </TableCell>
                        <TableCell>
                          {log.success ? (
                            <StatusBadge
                              kind="overall"
                              value={details?.status}
                              label={details?.status || 'unknown'}
                            />
                          ) : (
                            <Badge variant="destructive">failed</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {details?.containerHealth ? (
                            <span
                              className={
                                details.containerHealth.running ? 'text-green-400' : 'text-red-400'
                              }
                            >
                              {details.containerHealth.state}
                              {details.containerHealth.health && ` (${details.containerHealth.health})`}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {details?.urlHealth ? (
                            <span
                              className={details.urlHealth.success ? 'text-green-400' : 'text-red-400'}
                            >
                              {details.urlHealth.success ? 'OK' : 'Failed'}
                              {details.urlHealth.statusCode && ` (${details.urlHealth.statusCode})`}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {log.user?.email || 'System'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {healthPagination.totalPages > 1 && (
              <div className="mt-4">
                <DataPagination
                  currentPage={healthPagination.currentPage}
                  totalPages={healthPagination.totalPages}
                  totalItems={healthPagination.totalItems}
                  pageSize={healthPagination.pageSize}
                  onPageChange={healthPagination.setPage}
                  onPageSizeChange={healthPagination.setPageSize}
                  pageSizeOptions={[10, 25, 50]}
                />
              </div>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">No health checks recorded yet</p>
        )}
      </Card>

      {/* Action History */}
      <Card className="p-4 mt-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">Action History</h3>
          {actionHistory.length > 5 && (
            <Button
              variant="link"
              size="sm"
              onClick={() => setShowAllHistory(!showAllHistory)}
              className="h-auto p-0"
            >
              {showAllHistory ? 'Show Less' : `Show All (${actionHistory.length})`}
            </Button>
          )}
        </div>
        {actionHistory.length > 0 ? (
          <div className="space-y-2">
            {(showAllHistory ? actionHistory : actionHistory.slice(0, 5)).map((log) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const details = safeJsonParse<Record<string, any> | null>(log.details, null);
              return (
                <div
                  key={log.id}
                  className={cn(
                    'flex items-center justify-between p-3 rounded-lg',
                    log.success ? 'bg-muted/50' : 'bg-red-500/10'
                  )}
                >
                  <div className="flex items-center gap-3">
                    {/* Action icon */}
                    <div className={cn(
                      'size-8 rounded-full flex items-center justify-center',
                      log.action === 'deploy' ? 'bg-blue-500/20 text-blue-400' :
                      log.action === 'restart' ? 'bg-yellow-500/20 text-yellow-400' :
                      log.action === 'health_check' ? 'bg-green-500/20 text-green-400' :
                      log.action === 'update' ? 'bg-purple-500/20 text-purple-400' :
                      'bg-muted text-muted-foreground'
                    )}>
                      {log.action === 'deploy' && <Rocket className="size-4" />}
                      {log.action === 'restart' && <RotateCcw className="size-4" />}
                      {log.action === 'health_check' && <CheckCircle2 className="size-4" />}
                      {log.action === 'update' && <FilePenLine className="size-4" />}
                      {log.action === 'create' && <Plus className="size-4" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-foreground font-medium capitalize">{log.action.replace('_', ' ')}</span>
                        {!log.success && (
                          <Badge variant="destructive">failed</Badge>
                        )}
                        {log.action === 'deploy' && details?.imageTag && (
                          <span className="text-xs text-primary font-mono">{details.imageTag}</span>
                        )}
                        {log.action === 'health_check' && details?.status && (
                          <StatusBadge
                            kind="health"
                            value={details.healthStatus || details.status}
                            label={details.healthStatus || details.status}
                          />
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {log.user?.email || 'System'} • {format(new Date(log.createdAt), 'MMM d, HH:mm')}
                      </div>
                    </div>
                  </div>
                  {log.error && (
                    <div className="text-xs text-red-400 max-w-xs truncate" title={log.error}>
                      {log.error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-muted-foreground">No actions recorded yet</p>
        )}
      </Card>

      {/* Attach File Modal */}
      <Dialog open={showAttachFile} onOpenChange={(open) => !open && setShowAttachFile(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Attach Config File</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAttachFile} className="space-y-4">
            <div>
              <Label className="mb-1 block text-muted-foreground">Config File</Label>
              <div className="flex gap-2">
                <Select
                  value={attachConfigFileId}
                  onValueChange={(value) => {
                    setAttachConfigFileId(value);
                    // Auto-suggest target path based on selected file
                    const selected = configFiles.find((f) => f.id === value);
                    if (selected) {
                      const serviceName = service?.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'app';
                      const defaultPath = service?.composePath
                        ? service.composePath.replace(/[^/]+$/, selected.filename)
                        : `/opt/${serviceName}/${selected.filename}`;
                      setAttachTargetPath(defaultPath);
                    }
                  }}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select a file..." />
                  </SelectTrigger>
                  <SelectContent>
                    {configFiles
                      .filter((f) => !attachedFiles.some((af) => af.configFileId === f.id))
                      .map((file) => (
                        <SelectItem key={file.id} value={file.id}>
                          {file.name} ({file.filename})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowCreateFile(true)}
                  className="whitespace-nowrap"
                >
                  Create New
                </Button>
              </div>
            </div>
            <div>
              <Label className="mb-1 block text-muted-foreground">Target Path on Server</Label>
              <Input
                type="text"
                value={attachTargetPath}
                onChange={(e) => setAttachTargetPath(e.target.value)}
                placeholder={`/opt/${service?.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'app'}/config.yml`}
                className="font-mono text-sm"
                required
              />
              <p className="text-xs text-muted-foreground mt-1">
                Full path where the file will be written on the server
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowAttachFile(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={attaching || !attachConfigFileId}>
                {attaching ? 'Attaching...' : 'Attach'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* View File Content Modal */}
      <Dialog open={!!viewingFileContent} onOpenChange={(open) => !open && setViewingFileContent(null)}>
        <DialogContent className="sm:max-w-4xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{viewingFileContent?.name}</DialogTitle>
            <DialogDescription>{viewingFileContent?.filename}</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto">
            <pre className="text-sm font-mono text-foreground whitespace-pre-wrap">
              {viewingFileContent?.content}
            </pre>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create New Config File Modal */}
      <Dialog open={showCreateFile} onOpenChange={(open) => !open && setShowCreateFile(false)}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create New Config File</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateNewFile} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="mb-1 block text-muted-foreground">Display Name</Label>
                <Input
                  type="text"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="my-config"
                  required
                />
              </div>
              <div>
                <Label className="mb-1 block text-muted-foreground">Filename</Label>
                <Input
                  type="text"
                  value={newFileFilename}
                  onChange={(e) => setNewFileFilename(e.target.value)}
                  placeholder="config.yml"
                  required
                />
              </div>
            </div>
            <div>
              <Label className="mb-1 block text-muted-foreground">Description (optional)</Label>
              <Input
                type="text"
                value={newFileDescription}
                onChange={(e) => setNewFileDescription(e.target.value)}
                placeholder="Description..."
              />
            </div>
            <div>
              <Label className="mb-1 block text-muted-foreground">Content</Label>
              <Textarea
                value={newFileContent}
                onChange={(e) => setNewFileContent(e.target.value)}
                placeholder="Paste file content here..."
                rows={12}
                className="font-mono text-sm"
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowCreateFile(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creatingFile}>
                {creatingFile ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Config Modal */}
      <Dialog open={showConfig} onOpenChange={(open) => !open && setShowConfig(false)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Configure Service</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="mb-1 block text-muted-foreground">Container Name</Label>
                <Input
                  type="text"
                  value={editContainerName}
                  onChange={(e) => setEditContainerName(e.target.value)}
                  placeholder="my-container"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Must match <code>container_name</code> in compose. Discovery matches this, not the display name.
                </p>
              </div>
              <div>
                <Label className="mb-1 block text-muted-foreground">Service Type</Label>
                <Select
                  value={editServiceTypeId || '__none__'}
                  onValueChange={(value) => setEditServiceTypeId(value === '__none__' ? '' : value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {serviceTypes.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="mb-1 block text-muted-foreground">Compose Path</Label>
              <Input
                type="text"
                value={editComposePath}
                onChange={(e) => setEditComposePath(e.target.value)}
                placeholder="/opt/myservice/docker-compose.yml"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Path to docker-compose.yml on the server
              </p>
            </div>
            <div>
              <Label className="mb-1 block text-muted-foreground">Health Check URL</Label>
              <Input
                type="text"
                value={editHealthCheckUrl}
                onChange={(e) => setEditHealthCheckUrl(e.target.value)}
                placeholder="http://localhost:8000/health"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                URL to check during health checks (from the server via agent)
              </p>
            </div>
            {containerImage && (
              <div className="p-3 bg-muted/50 rounded-lg">
                <Label className="mb-1 block text-muted-foreground">Container Image</Label>
                <Link to="/container-images" className="text-primary hover:underline">
                  {containerImage.name} ({containerImage.imageName})
                </Link>
                <p className="text-xs text-muted-foreground mt-1">
                  Image name and registry are managed via Container Images
                </p>
              </div>
            )}

            {/* TCP Port Checks */}
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-2">
                <Label className="text-muted-foreground">
                  TCP Port Checks (Agent)
                  {schedulerConfig && !schedulerConfig.collectTcpChecks && (
                    <span className="text-yellow-500 text-xs ml-2">(disabled in environment settings)</span>
                  )}
                </Label>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => setEditTcpChecks([...editTcpChecks, { host: 'localhost', port: 0, name: '' }])}
                  className="h-auto p-0"
                  disabled={schedulerConfig !== null && !schedulerConfig.collectTcpChecks}
                >
                  + Add Check
                </Button>
              </div>
              {editTcpChecks.length > 0 ? (
                <div className="space-y-2">
                  {editTcpChecks.map((check, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <Input
                        type="text"
                        value={check.host}
                        onChange={(e) => {
                          const newChecks = [...editTcpChecks];
                          newChecks[i] = { ...check, host: e.target.value };
                          setEditTcpChecks(newChecks);
                        }}
                        placeholder="host"
                        className="font-mono text-sm flex-1"
                      />
                      <Input
                        type="number"
                        value={check.port || ''}
                        onChange={(e) => {
                          const newChecks = [...editTcpChecks];
                          newChecks[i] = { ...check, port: parseInt(e.target.value) || 0 };
                          setEditTcpChecks(newChecks);
                        }}
                        placeholder="port"
                        className="font-mono text-sm w-24"
                      />
                      <Input
                        type="text"
                        value={check.name || ''}
                        onChange={(e) => {
                          const newChecks = [...editTcpChecks];
                          newChecks[i] = { ...check, name: e.target.value };
                          setEditTcpChecks(newChecks);
                        }}
                        placeholder="label (optional)"
                        className="text-sm w-32"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditTcpChecks(editTcpChecks.filter((_, j) => j !== i))}
                        className="text-red-400 hover:text-red-300"
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No TCP checks configured. Agent will check port connectivity.</p>
              )}
            </div>

            {/* Certificate Expiry Checks */}
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-2">
                <Label className="text-muted-foreground">
                  Certificate Expiry Checks (Agent)
                  {schedulerConfig && !schedulerConfig.collectCertChecks && (
                    <span className="text-yellow-500 text-xs ml-2">(disabled in environment settings)</span>
                  )}
                </Label>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => setEditCertChecks([...editCertChecks, { host: '', port: 443, name: '' }])}
                  className="h-auto p-0"
                  disabled={schedulerConfig !== null && !schedulerConfig.collectCertChecks}
                >
                  + Add Check
                </Button>
              </div>
              {editCertChecks.length > 0 ? (
                <div className="space-y-2">
                  {editCertChecks.map((check, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <Input
                        type="text"
                        value={check.host}
                        onChange={(e) => {
                          const newChecks = [...editCertChecks];
                          newChecks[i] = { ...check, host: e.target.value };
                          setEditCertChecks(newChecks);
                        }}
                        placeholder="hostname"
                        className="font-mono text-sm flex-1"
                      />
                      <Input
                        type="number"
                        value={check.port || ''}
                        onChange={(e) => {
                          const newChecks = [...editCertChecks];
                          newChecks[i] = { ...check, port: parseInt(e.target.value) || 443 };
                          setEditCertChecks(newChecks);
                        }}
                        placeholder="port"
                        className="font-mono text-sm w-24"
                      />
                      <Input
                        type="text"
                        value={check.name || ''}
                        onChange={(e) => {
                          const newChecks = [...editCertChecks];
                          newChecks[i] = { ...check, name: e.target.value };
                          setEditCertChecks(newChecks);
                        }}
                        placeholder="label (optional)"
                        className="text-sm w-32"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditCertChecks(editCertChecks.filter((_, j) => j !== i))}
                        className="text-red-400 hover:text-red-300"
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No certificate checks configured. Agent will check TLS cert expiry.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowConfig(false)}>
              Cancel
            </Button>
            <Button onClick={saveConfig} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Logs Modal */}
      <Dialog
        open={showLogs}
        onOpenChange={(open) => {
          if (!open) {
            setShowLogs(false);
            // Clear so a reopen always transitions '' -> content, which
            // guarantees the [logs] layout effect re-fires and re-pins to
            // the newest entry even if the logs are byte-identical.
            setLogs('');
          }
        }}
      >
        <DialogContent className="sm:max-w-4xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Logs - {service.containerName}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-between border-y py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={loadOlderLogs}
              disabled={!oldestLogTimestamp || logsLoadingOlder || noMoreOlderLogs || logsLoading}
              title={noMoreOlderLogs ? 'No earlier logs available' : 'Load earlier log entries'}
            >
              {logsLoadingOlder ? 'Loading...' : noMoreOlderLogs ? 'No earlier logs' : 'Load older'}
            </Button>
            <div className="text-xs text-muted-foreground">
              {logsLoading ? 'Loading...' : oldestLogTimestamp ? `Oldest visible: ${oldestLogTimestamp}` : ''}
            </div>
          </div>
          <pre
            ref={logsContainerRef}
            className="flex-1 overflow-auto font-mono text-sm text-foreground bg-background rounded-md p-4"
          >
            {logs || (logsLoading ? 'Loading logs...' : 'No logs available')}
          </pre>
        </DialogContent>
      </Dialog>

      {/* Deploy Modal */}
      <Dialog open={showDeployModal} onOpenChange={(open) => !open && setShowDeployModal(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Deploy Service</DialogTitle>
            <DialogDescription>{service.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {containerImage?.latestDigest ? (
              <>
                <div className="bg-muted/50 rounded p-3">
                  <div className="text-sm text-muted-foreground mb-1">Digest</div>
                  <div className="font-mono text-foreground text-sm">
                    {formatDigestShort(containerImage.latestDigest.manifestDigest)}
                  </div>
                </div>
                <div className="bg-muted/50 rounded p-3">
                  <div className="text-sm text-muted-foreground mb-2">Tags</div>
                  <div className="flex flex-wrap gap-1">
                    {containerImage.latestDigest.tags.length > 0 ? (
                      containerImage.latestDigest.tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="font-mono">
                          {tag}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-muted-foreground italic text-sm">No tags</span>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-muted/50 rounded p-3">
                <div className="text-sm text-muted-foreground mb-1">Tag</div>
                <div className="font-mono text-foreground text-sm">{service.imageTag || 'latest'}</div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDeployModal(false)}>
              Cancel
            </Button>
            <Button onClick={() => handleDeploy()} disabled={deploying}>
              {deploying ? 'Starting Deploy...' : 'Deploy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useEffect, useState, useRef } from 'react';
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
  listRegistryConnections,
  getAuditLogs,
  getServiceHistory,
  getServiceDependencies,
  getManagedImage,
  listServiceTypes,
  type ServiceWithServer,
  type Deployment,
  type ServiceFile,
  type ConfigFile,
  type SyncResult,
  type RegistryConnection,
  type AuditLog,
  type ExposedPort,
  type ServiceHistoryEntry,
  type ServiceDependency,
  type ManagedImage,
  type ServiceType,
} from '../lib/api';
import { DependencyEditor } from '../components/DependencyEditor';
import { HealthConfigEditor } from '../components/HealthConfigEditor';
import Pagination from '../components/Pagination';
import { usePagination } from '../hooks/usePagination';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import { formatDistanceToNow, format } from 'date-fns';
import {
  getContainerStatusColor,
  getHealthStatusColor,
  getOverallStatusDotColor,
  getContainerHealthTextColor,
} from '../lib/status';

function parseExposedPorts(portsJson: string | null): ExposedPort[] {
  if (!portsJson) return [];
  try {
    return JSON.parse(portsJson);
  } catch {
    return [];
  }
}

export default function ServiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const [service, setService] = useState<ServiceWithServer | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [logs, setLogs] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [saving, setSaving] = useState(false);
  const [imageTag, setImageTag] = useState('');

  // Inline deploy card editing state
  const [editingImageName, setEditingImageName] = useState(false);
  const [editingCurrentTag, setEditingCurrentTag] = useState(false);
  const [editingRegistry, setEditingRegistry] = useState(false);
  const [inlineImageName, setInlineImageName] = useState('');
  const [inlineCurrentTag, setInlineCurrentTag] = useState('');
  const [inlineRegistryId, setInlineRegistryId] = useState('');
  const [savingInline, setSavingInline] = useState(false);

  // Config edit state
  const [editComposePath, setEditComposePath] = useState<string>('');
  const [editContainerName, setEditContainerName] = useState<string>('');
  const [editImageName, setEditImageName] = useState<string>('');
  const [editHealthCheckUrl, setEditHealthCheckUrl] = useState<string>('');
  const [editRegistryConnectionId, setEditRegistryConnectionId] = useState<string>('');

  // Attached files state
  const [attachedFiles, setAttachedFiles] = useState<ServiceFile[]>([]);
  const [configFiles, setConfigFiles] = useState<ConfigFile[]>([]);
  const [showAttachFile, setShowAttachFile] = useState(false);
  const [attachConfigFileId, setAttachConfigFileId] = useState('');
  const [attachTargetPath, setAttachTargetPath] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResults, setSyncResults] = useState<SyncResult[] | null>(null);
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

  // Registry and auto-update state
  const [registries, setRegistries] = useState<RegistryConnection[]>([]);
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>([]);
  const [editServiceTypeId, setEditServiceTypeId] = useState<string>('');
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<{
    hasUpdate: boolean;
    latestTag?: string;
  } | null>(null);
  const [togglingAutoUpdate, setTogglingAutoUpdate] = useState(false);

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
  const [managedImage, setManagedImage] = useState<ManagedImage | null>(null);

  // Pagination hooks (must be at top level)
  const deploymentPagination = usePagination({ data: deployments, defaultPageSize: 10 });
  const healthPagination = usePagination({ data: healthCheckHistory, defaultPageSize: 10 });

  useEffect(() => {
    if (id) {
      setLoading(true);
      Promise.all([
        getService(id).then(({ service }) => {
          setService(service);
          setImageTag(service.imageTag);
          // Load managed image if linked
          if (service.managedImageId) {
            getManagedImage(service.managedImageId)
              .then(({ image }) => setManagedImage(image))
              .catch(() => setManagedImage(null));
          }
        }),
        getDeploymentHistory(id).then(({ deployments }) => setDeployments(deployments)),
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
      listRegistryConnections(selectedEnvironment.id).then(({ registries }) =>
        setRegistries(registries)
      );
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
        latestTag: result.latestTag,
      });
      // Update the service state with new values
      if (service) {
        setService({
          ...service,
          latestAvailableTag: result.latestTag || service.latestAvailableTag,
          lastUpdateCheckAt: result.lastUpdateCheckAt || service.lastUpdateCheckAt,
        });
      }
    } catch (error) {
      console.error('Update check failed:', error);
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handleToggleAutoUpdate = async () => {
    if (!id || !service) return;
    setTogglingAutoUpdate(true);
    try {
      const { service: updated } = await updateService(id, {
        autoUpdate: !service.autoUpdate,
      });
      setService((prev) => (prev ? { ...prev, autoUpdate: updated.autoUpdate } : null));
    } finally {
      setTogglingAutoUpdate(false);
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

  // Inline deploy card editing handlers
  const startEditImageName = () => {
    if (service) {
      setInlineImageName(service.imageName || '');
      setEditingImageName(true);
    }
  };

  const startEditCurrentTag = () => {
    if (service) {
      setInlineCurrentTag(service.imageTag || '');
      setEditingCurrentTag(true);
    }
  };

  const startEditRegistry = () => {
    if (service) {
      setInlineRegistryId(service.registryConnectionId || '');
      setEditingRegistry(true);
    }
  };

  const cancelInlineEdit = () => {
    setEditingImageName(false);
    setEditingCurrentTag(false);
    setEditingRegistry(false);
  };

  const saveInlineImageName = async () => {
    if (!id || !service || inlineImageName === service.imageName) {
      cancelInlineEdit();
      return;
    }
    setSavingInline(true);
    try {
      const { service: updated } = await updateService(id, { imageName: inlineImageName });
      setService((prev) => (prev ? { ...prev, imageName: updated.imageName } : null));
      setEditingImageName(false);
      toast.success('Image name updated');
    } catch {
      toast.error('Failed to update image name');
    } finally {
      setSavingInline(false);
    }
  };

  const saveInlineCurrentTag = async () => {
    if (!id || !service || inlineCurrentTag === service.imageTag) {
      cancelInlineEdit();
      return;
    }
    setSavingInline(true);
    try {
      const { service: updated } = await updateService(id, { imageTag: inlineCurrentTag });
      setService((prev) => (prev ? { ...prev, imageTag: updated.imageTag } : null));
      setImageTag(updated.imageTag); // Also update the deploy tag input
      setEditingCurrentTag(false);
      toast.success('Image tag updated');
    } catch {
      toast.error('Failed to update image tag');
    } finally {
      setSavingInline(false);
    }
  };

  const saveInlineRegistry = async () => {
    if (!id || !service || inlineRegistryId === (service.registryConnectionId || '')) {
      cancelInlineEdit();
      return;
    }
    setSavingInline(true);
    try {
      const { service: updated } = await updateService(id, {
        registryConnectionId: inlineRegistryId || null,
      });
      setService((prev) => (prev ? { ...prev, registryConnectionId: updated.registryConnectionId } : null));
      setEditingRegistry(false);
      toast.success('Registry updated');
    } catch {
      toast.error('Failed to update registry');
    } finally {
      setSavingInline(false);
    }
  };

  const handleInlineKeyDown = (e: React.KeyboardEvent, saveHandler: () => void) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveHandler();
    } else if (e.key === 'Escape') {
      cancelInlineEdit();
    }
  };

  const handleDeploy = async () => {
    if (!id) return;
    setDeploying(true);
    setDeployError(null);
    try {
      const result = await deployService(id, { imageTag, pullImage: true });
      setDeployments((prev) => [result.deployment, ...prev]);
      if (service) {
        setService({ ...service, imageTag, status: 'running' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deployment failed';
      setDeployError(message);
      // Refresh deployment history to get the failed deployment
      getDeploymentHistory(id).then(({ deployments }) => setDeployments(deployments));
    } finally {
      setDeploying(false);
    }
  };

  const handleRestart = async () => {
    if (!id) return;
    setRestarting(true);
    try {
      await restartService(id);
    } finally {
      setRestarting(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !service) return;
    if (!confirm(`Are you sure you want to delete the service "${service.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteService(id);
      navigate(`/servers/${service.server.id}`);
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
      setImageTag(result.imageTag);
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

  const loadLogs = async () => {
    if (!id) return;
    try {
      const { logs } = await getServiceLogs(id, 200);
      setLogs(logs);
      setShowLogs(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load logs';
      if (message.includes('No such container')) {
        setLogs('Container not found. The service may not be running or has not been deployed yet.');
        setShowLogs(true);
      } else {
        toast.error(message);
      }
    }
  };

  const openConfig = () => {
    if (!service) return;
    setEditComposePath(service.composePath || '');
    setEditContainerName(service.containerName || '');
    setEditImageName(service.imageName || '');
    setEditHealthCheckUrl(service.healthCheckUrl || '');
    setEditRegistryConnectionId(service.registryConnectionId || '');
    setEditServiceTypeId(service.serviceTypeId || '');
    setShowConfig(true);
  };

  const saveConfig = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const { service: updated } = await updateService(id, {
        composePath: editComposePath || null,
        containerName: editContainerName || undefined,
        imageName: editImageName || undefined,
        healthCheckUrl: editHealthCheckUrl || null,
        registryConnectionId: editRegistryConnectionId || null,
        serviceTypeId: editServiceTypeId || null,
      });
      setService((prev) => (prev ? { ...prev, ...updated } : null));
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
    if (!confirm('Detach this file from the service?')) return;
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
    try {
      const { results } = await syncServiceFiles(id);
      setSyncResults(results);
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
      setViewingFileContent({ name: fileName, filename, content: configFile.content });
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
      const defaultPath = service?.composePath
        ? service.composePath.replace(/[^/]+$/, configFile.filename)
        : `/opt/app/${configFile.filename}`;
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
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-7 w-48 bg-slate-700 rounded mb-5"></div>
          <div className="h-64 bg-slate-800 rounded-lg"></div>
        </div>
      </div>
    );
  }

  if (!service) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-slate-400">Service not found</p>
          <Link to="/services" className="btn btn-primary mt-4">
            Back to Services
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Missing Service Warning */}
      {service.discoveryStatus === 'missing' && (
        <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4 mb-5">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-orange-400 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <h4 className="text-orange-400 font-medium">Container Not Found</h4>
              <p className="text-orange-300/80 text-sm mt-1">
                This container was not found during the last discovery. It may have been stopped, removed, or crashed.
                {service.lastDiscoveredAt && (
                  <> Last seen {formatDistanceToNow(new Date(service.lastDiscoveredAt), { addSuffix: true })}.</>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-3">
            {/* Container Status Badge */}
            <span className={`badge ${getContainerStatusColor(service.containerStatus || service.status)}`}>
              {service.containerStatus || service.status}
            </span>
            {/* Health Status Badge */}
            <span className={`badge ${getHealthStatusColor(service.healthStatus || 'unknown')}`}>
              {service.healthStatus || 'unknown'}
            </span>
            {/* Inline Editable Name */}
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  ref={nameInputRef}
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={handleNameKeyDown}
                  onBlur={saveEditName}
                  disabled={savingName}
                  className="text-xl font-bold bg-slate-800 text-white border border-primary-500 rounded px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  style={{ minWidth: '200px' }}
                />
                {savingName && (
                  <span className="text-sm text-slate-400">Saving...</span>
                )}
              </div>
            ) : (
              <h1
                className="text-xl font-bold text-white cursor-pointer hover:text-primary-400 group flex items-center gap-2"
                onClick={startEditingName}
                title="Click to edit service name"
              >
                {service.name}
                <svg className="w-4 h-4 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </h1>
            )}
          </div>
          <p className="text-slate-400 mt-1">
            on{' '}
            <Link
              to={`/servers/${service.server.id}`}
              className="text-primary-400 hover:underline"
            >
              {service.server.name}
            </Link>
            {' • '}
            {service.server.environment.name}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadLogs}
            className="btn btn-ghost"
          >
            View Logs
          </button>
          <button
            onClick={handleHealthCheck}
            disabled={checking}
            className="btn btn-ghost"
          >
            {checking ? 'Checking...' : 'Health Check'}
          </button>
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="btn btn-secondary"
          >
            {restarting ? 'Restarting...' : 'Restart'}
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="btn bg-red-600 hover:bg-red-700 text-white"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>

      {/* Update Available Banner */}
      {service.latestAvailableTag && service.latestAvailableTag !== service.imageTag && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 mb-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              <div>
                <h4 className="text-blue-400 font-medium">Update Available</h4>
                <p className="text-blue-300/80 text-sm">
                  New version <code className="bg-blue-500/20 px-1 rounded">{service.latestAvailableTag}</code> is available
                  (current: {service.imageTag})
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                setImageTag(service.latestAvailableTag!);
                handleDeploy();
              }}
              disabled={deploying}
              className="btn btn-primary"
            >
              {deploying ? 'Deploying...' : 'Deploy Update'}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-5">
        {/* Deploy Card */}
        <div className="col-span-2 panel">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Deploy</h3>
            {service.registryConnectionId && (
              <button
                onClick={handleCheckUpdates}
                disabled={checkingUpdates}
                className="btn btn-ghost text-sm"
              >
                {checkingUpdates ? 'Checking...' : 'Check for Updates'}
              </button>
            )}
          </div>
          <div className="space-y-4">
            {/* Image info - editable */}
            <div className="grid grid-cols-2 gap-4 p-3 bg-slate-800/50 rounded-lg">
              <div>
                <dt className="text-xs text-slate-500 uppercase tracking-wide">Image Name</dt>
                {editingImageName ? (
                  <div className="flex items-center gap-2 mt-0.5">
                    <input
                      type="text"
                      value={inlineImageName}
                      onChange={(e) => setInlineImageName(e.target.value)}
                      onKeyDown={(e) => handleInlineKeyDown(e, saveInlineImageName)}
                      onBlur={saveInlineImageName}
                      disabled={savingInline}
                      autoFocus
                      className="flex-1 bg-slate-900 border border-primary-500 rounded px-2 py-0.5 text-white font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
                    />
                  </div>
                ) : (
                  <dd
                    className="text-white font-mono text-sm mt-0.5 cursor-pointer hover:text-primary-400 group flex items-center gap-1"
                    onClick={startEditImageName}
                    title="Click to edit"
                  >
                    {service.imageName || <span className="text-slate-500 italic">Not set</span>}
                    <svg className="w-3 h-3 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </dd>
                )}
              </div>
              <div>
                <dt className="text-xs text-slate-500 uppercase tracking-wide">Image Tag</dt>
                {editingCurrentTag ? (
                  <div className="flex items-center gap-2 mt-0.5">
                    <input
                      type="text"
                      value={inlineCurrentTag}
                      onChange={(e) => setInlineCurrentTag(e.target.value)}
                      onKeyDown={(e) => handleInlineKeyDown(e, saveInlineCurrentTag)}
                      onBlur={saveInlineCurrentTag}
                      disabled={savingInline}
                      autoFocus
                      className="flex-1 bg-slate-900 border border-primary-500 rounded px-2 py-0.5 text-white font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
                    />
                  </div>
                ) : (
                  <dd
                    className="text-white font-mono text-sm mt-0.5 cursor-pointer hover:text-primary-400 group flex items-center gap-1"
                    onClick={startEditCurrentTag}
                    title="Click to edit"
                  >
                    {service.imageTag || <span className="text-slate-500 italic">Not set</span>}
                    <svg className="w-3 h-3 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </dd>
                )}
              </div>
              <div>
                <dt className="text-xs text-slate-500 uppercase tracking-wide">Registry</dt>
                {editingRegistry ? (
                  <div className="flex items-center gap-2 mt-0.5">
                    <select
                      value={inlineRegistryId}
                      onChange={(e) => setInlineRegistryId(e.target.value)}
                      onBlur={saveInlineRegistry}
                      disabled={savingInline}
                      autoFocus
                      className="flex-1 bg-slate-900 border border-primary-500 rounded px-2 py-0.5 text-white text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
                    >
                      <option value="">None</option>
                      {registries.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} {r.isDefault ? '(default)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <dd
                    className="text-white text-sm mt-0.5 cursor-pointer hover:text-primary-400 group flex items-center gap-1"
                    onClick={startEditRegistry}
                    title="Click to edit"
                  >
                    {(() => {
                      const registry = registries.find(r => r.id === service.registryConnectionId);
                      return registry ? (
                        <span className="text-primary-400">{registry.name}</span>
                      ) : (
                        <span className="text-slate-500 italic">Not linked</span>
                      );
                    })()}
                    <svg className="w-3 h-3 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </dd>
                )}
              </div>
              <div>
                <dt className="text-xs text-slate-500 uppercase tracking-wide">Current Image</dt>
                <dd className="text-primary-400 font-mono text-sm mt-0.5 break-all">
                  {service.imageName && service.imageTag ? (
                    `${service.imageName}:${service.imageTag}`
                  ) : (
                    <span className="text-slate-500 italic">Not configured</span>
                  )}
                </dd>
              </div>
            </div>

            <div>
              <label className="block text-sm text-slate-400 mb-1">
                Deploy Tag
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={imageTag}
                  onChange={(e) => setImageTag(e.target.value)}
                  placeholder="latest"
                  className="input flex-1"
                />
                <button
                  onClick={handleDeploy}
                  disabled={deploying}
                  className="btn btn-primary"
                >
                  {deploying ? 'Deploying...' : 'Deploy'}
                </button>
              </div>
            </div>

            {/* Auto-update toggle */}
            {service.registryConnectionId && (
              <div className="flex items-center justify-between pt-4 border-t border-slate-700">
                <div>
                  <p className="text-white font-medium">Auto-update</p>
                  <p className="text-sm text-slate-400">
                    Automatically deploy when new versions are available
                  </p>
                </div>
                <button
                  onClick={handleToggleAutoUpdate}
                  disabled={togglingAutoUpdate}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    service.autoUpdate ? 'bg-primary-600' : 'bg-slate-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      service.autoUpdate ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            )}

            {/* Last update check */}
            {service.lastUpdateCheckAt && (
              <p className="text-xs text-slate-500">
                Last checked {formatDistanceToNow(new Date(service.lastUpdateCheckAt), { addSuffix: true })}
              </p>
            )}

            {/* Update check result */}
            {updateCheckResult && (
              <div className={`text-sm ${updateCheckResult.hasUpdate ? 'text-blue-400' : 'text-green-400'}`}>
                {updateCheckResult.hasUpdate
                  ? `Update available: ${updateCheckResult.latestTag}`
                  : 'No updates available'}
              </div>
            )}

            {/* Deploy error */}
            {deployError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <div className="flex items-start gap-2">
                  <svg className="w-5 h-5 text-red-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className="flex-1">
                    <p className="text-red-400 font-medium">Deployment Failed</p>
                    <p className="text-red-300/80 text-sm mt-1">{deployError}</p>
                  </div>
                  <button
                    onClick={() => setDeployError(null)}
                    className="text-red-400 hover:text-red-300"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Service Info */}
        <div className="panel">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Details</h3>
            <button onClick={openConfig} className="btn btn-ghost text-sm">
              Configure
            </button>
          </div>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-slate-400">Container</dt>
              <dd className="text-white font-mono">{service.containerName}</dd>
            </div>
            {/* Exposed Ports */}
            <div>
              <dt className="text-slate-400">Ports</dt>
              <dd className="text-white">
                {(() => {
                  const ports = parseExposedPorts(service.exposedPorts);
                  if (ports.length === 0) {
                    return <span className="text-slate-500">No ports exposed</span>;
                  }
                  return (
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {ports.map((port, i) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 bg-slate-700 rounded text-xs font-mono"
                          title={`${port.protocol.toUpperCase()}`}
                        >
                          {port.host ? `${port.host}:${port.container}` : port.container}
                        </span>
                      ))}
                    </div>
                  );
                })()}
              </dd>
            </div>
            {service.composePath && (
              <div>
                <dt className="text-slate-400">Compose Path</dt>
                <dd className="text-white font-mono text-xs">
                  {service.composePath}
                </dd>
              </div>
            )}
            {service.healthCheckUrl && (
              <div>
                <dt className="text-slate-400">Health Check URL</dt>
                <dd className="text-white font-mono text-xs">
                  {service.healthCheckUrl}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-slate-400">Last Checked</dt>
              <dd className="text-white">
                {service.lastCheckedAt
                  ? formatDistanceToNow(new Date(service.lastCheckedAt), {
                      addSuffix: true,
                    })
                  : 'Never'}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Orchestration Row: Dependencies & Health Config */}
      <div className="grid grid-cols-2 gap-4 mb-5">
        {/* Dependencies Card */}
        <div className="panel">
          <h3 className="text-lg font-semibold text-white mb-4">Dependencies</h3>
          <DependencyEditor serviceId={id!} onUpdate={refreshDependencies} />
          {dependencies.length > 0 && (
            <div className="mt-4 pt-4 border-t border-slate-700">
              <p className="text-xs text-slate-500 mb-2">Current Dependencies</p>
              <div className="space-y-2">
                {dependencies.map((dep) => (
                  <div
                    key={dep.id}
                    className="flex items-center justify-between p-2 bg-slate-800/50 rounded"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        dep.type === 'health_before'
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-blue-500/20 text-blue-400'
                      }`}>
                        {dep.type === 'health_before' ? 'waits for healthy' : 'deploys after'}
                      </span>
                      <Link
                        to={`/services/${dep.dependsOn.id}`}
                        className="text-primary-400 hover:underline"
                      >
                        {dep.dependsOn.name}
                      </Link>
                    </div>
                    <span className="text-xs text-slate-500">
                      on {dep.dependsOn.server?.name}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {managedImage && (
            <div className="mt-4 pt-4 border-t border-slate-700">
              <p className="text-xs text-slate-500 mb-2">Managed Image</p>
              <Link
                to="/managed-images"
                className="flex items-center gap-2 p-2 bg-primary-500/10 border border-primary-500/30 rounded hover:bg-primary-500/20"
              >
                <svg className="w-4 h-4 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span className="text-white font-medium">{managedImage.name}</span>
                <span className="text-xs text-primary-400 font-mono ml-auto">
                  :{managedImage.currentTag}
                </span>
              </Link>
            </div>
          )}
        </div>

        {/* Health Check Config Card */}
        <div className="panel">
          <h3 className="text-lg font-semibold text-white mb-4">Health Check Config</h3>
          <p className="text-sm text-slate-400 mb-4">
            Configure how health checks work during orchestrated deployments.
          </p>
          {service && (
            <HealthConfigEditor
              serviceId={id!}
              initialConfig={{
                healthWaitMs: service.healthWaitMs ?? 30000,
                healthRetries: service.healthRetries ?? 3,
                healthIntervalMs: service.healthIntervalMs ?? 5000,
              }}
              onUpdate={() => {
                // Refresh service to get updated health config
                if (id) {
                  getService(id).then(({ service }) => setService(service));
                }
              }}
            />
          )}
        </div>
      </div>

      {/* Health Check Result/Error */}
      {(healthCheckError || healthCheckResult) && (
        <div className="panel mb-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Health Check Result</h3>
            <button
              onClick={() => {
                setHealthCheckError(null);
                setHealthCheckResult(null);
              }}
              className="text-slate-400 hover:text-white text-sm"
            >
              Dismiss
            </button>
          </div>

          {healthCheckError && (
            <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-red-400 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-red-400 font-medium">Health Check Failed</p>
                  <p className="text-red-300/80 text-sm mt-1">{healthCheckError}</p>
                </div>
              </div>
            </div>
          )}

          {healthCheckResult && (
            <div className="space-y-4">
              {/* Overall Status */}
              <div className="flex items-center gap-3">
                <span className={`w-3 h-3 rounded-full ${getOverallStatusDotColor(healthCheckResult.status)}`} />
                <span className="text-white font-medium capitalize">{healthCheckResult.status}</span>
              </div>

              {/* Container Details */}
              <div className="p-3 bg-slate-800 rounded-lg">
                <p className="text-slate-400 text-sm mb-2">Container</p>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-slate-500">State</dt>
                    <dd className="text-white">{healthCheckResult.container.state}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Status</dt>
                    <dd className="text-white">{healthCheckResult.container.status}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Running</dt>
                    <dd className={healthCheckResult.container.running ? 'text-green-400' : 'text-red-400'}>
                      {healthCheckResult.container.running ? 'Yes' : 'No'}
                    </dd>
                  </div>
                  {healthCheckResult.container.health && (
                    <div>
                      <dt className="text-slate-500">Health</dt>
                      <dd className={getContainerHealthTextColor(healthCheckResult.container.health)}>
                        {healthCheckResult.container.health}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>

              {/* URL Check Details */}
              {healthCheckResult.url && (
                <div className="p-3 bg-slate-800 rounded-lg">
                  <p className="text-slate-400 text-sm mb-2">URL Health Check</p>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-slate-500">Status</dt>
                      <dd className={healthCheckResult.url.success ? 'text-green-400' : 'text-red-400'}>
                        {healthCheckResult.url.success ? 'Success' : 'Failed'}
                      </dd>
                    </div>
                    {healthCheckResult.url.statusCode && (
                      <div>
                        <dt className="text-slate-500">HTTP Code</dt>
                        <dd className="text-white">{healthCheckResult.url.statusCode}</dd>
                      </div>
                    )}
                    {healthCheckResult.url.error && (
                      <div className="col-span-2">
                        <dt className="text-slate-500">Error</dt>
                        <dd className="text-red-400 text-xs">{healthCheckResult.url.error}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Config Files - Moved up per plan */}
      <div className="panel mb-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">Config Files</h3>
          <div className="flex gap-2">
            {attachedFiles.length > 0 && (
              <button
                onClick={handleSyncFiles}
                disabled={syncing}
                className="btn btn-secondary"
              >
                {syncing ? 'Syncing...' : 'Sync to Server'}
              </button>
            )}
            <button onClick={openAttachFile} className="btn btn-ghost">
              Attach File
            </button>
          </div>
        </div>

        {/* Sync Results */}
        {syncResults && (
          <div className="mb-4 p-3 bg-slate-800/50 rounded-lg border border-slate-700">
            <p className="text-sm text-slate-400 mb-2">Sync Results:</p>
            <div className="space-y-1">
              {syncResults.map((result, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  {result.success ? (
                    <span className="text-green-400">✓</span>
                  ) : (
                    <span className="text-red-400">✕</span>
                  )}
                  <span className="text-white">{result.file}</span>
                  <span className="text-slate-500">→</span>
                  <code className="text-slate-400 text-xs">{result.targetPath}</code>
                  {result.error && (
                    <span className="text-red-400 text-xs">({result.error})</span>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={() => setSyncResults(null)}
              className="mt-2 text-xs text-slate-400 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        )}

        {attachedFiles.length > 0 ? (
          <div className="space-y-2">
            {attachedFiles.map((file) => (
              <div
                key={file.id}
                className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium">{file.configFile.name}</span>
                    <span className="text-xs text-slate-500">({file.configFile.filename})</span>
                    {file.configFile.isBinary && (
                      <span className="px-1.5 py-0.5 text-xs bg-purple-900/30 text-purple-400 rounded" title={file.configFile.mimeType || 'Binary file'}>
                        binary
                      </span>
                    )}
                  </div>
                  {editingMountPath === file.configFileId ? (
                    <div className="flex items-center gap-2 mt-1">
                      <input
                        type="text"
                        value={editMountPathValue}
                        onChange={(e) => setEditMountPathValue(e.target.value)}
                        onKeyDown={(e) => handleMountPathKeyDown(e, file.configFileId)}
                        onBlur={() => saveMountPath(file.configFileId)}
                        disabled={savingMountPath}
                        autoFocus
                        className="flex-1 bg-slate-900 border border-primary-500 rounded px-2 py-0.5 text-green-400 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
                      />
                    </div>
                  ) : (
                    <code
                      className="text-sm text-green-400 cursor-pointer hover:text-green-300 group flex items-center gap-1"
                      onClick={() => startEditMountPath(file.configFileId, file.targetPath)}
                      title="Click to edit mount path"
                    >
                      {file.targetPath}
                      <svg className="w-3 h-3 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </code>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {!file.configFile.isBinary && (
                    <button
                      onClick={() => handleViewFileContent(file.configFileId, file.configFile.name, file.configFile.filename)}
                      className="p-1 text-slate-400 hover:text-primary-400"
                      title="View Content"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    </button>
                  )}
                  <button
                    onClick={() => handleDetachFile(file.configFileId)}
                    className="p-1 text-slate-400 hover:text-red-400"
                    title="Detach"
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
          <p className="text-slate-400 text-sm">
            No config files attached. Attach files to sync docker-compose, Caddyfile, certificates, etc.
          </p>
        )}
      </div>

      {/* Deployment History */}
      <div className="panel">
            <h3 className="text-lg font-semibold text-white mb-4">
              Deployment History
            </h3>
            {deployments.length > 0 ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                        <th className="pb-3 font-medium">Tag</th>
                        <th className="pb-3 font-medium">Status</th>
                        <th className="pb-3 font-medium">Triggered By</th>
                        <th className="pb-3 font-medium">Started</th>
                        <th className="pb-3 font-medium">Duration</th>
                        <th className="pb-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                      {deploymentPagination.paginatedData.map((deployment) => (
                        <>
                          <tr key={deployment.id} className="text-slate-300">
                            <td className="py-3 font-mono text-primary-400">
                              {deployment.imageTag}
                            </td>
                            <td className="py-3">
                              <span
                                className={`badge ${
                                  deployment.status === 'success'
                                    ? 'badge-success'
                                    : deployment.status === 'failed'
                                    ? 'badge-error'
                                    : deployment.status === 'deploying'
                                    ? 'badge-info'
                                    : 'badge-warning'
                                }`}
                              >
                                {deployment.status}
                              </span>
                            </td>
                            <td className="py-3">{deployment.triggeredBy}</td>
                            <td className="py-3 text-sm">
                              {format(new Date(deployment.startedAt), 'MMM d, HH:mm')}
                            </td>
                            <td className="py-3 text-sm text-slate-400">
                              {deployment.completedAt
                                ? `${Math.round(
                                    (new Date(deployment.completedAt).getTime() -
                                      new Date(deployment.startedAt).getTime()) /
                                      1000
                                  )}s`
                                : '-'}
                            </td>
                            <td className="py-3 text-right">
                              {deployment.logs && (
                                <button
                                  onClick={() =>
                                    setExpandedDeployment(
                                      expandedDeployment === deployment.id ? null : deployment.id
                                    )
                                  }
                                  className={`text-sm ${
                                    deployment.status === 'failed'
                                      ? 'text-red-400 hover:text-red-300'
                                      : 'text-slate-400 hover:text-white'
                                  }`}
                                >
                                  {expandedDeployment === deployment.id ? 'Hide Logs' : 'View Logs'}
                                </button>
                              )}
                            </td>
                          </tr>
                          {expandedDeployment === deployment.id && deployment.logs && (
                            <tr key={`${deployment.id}-logs`}>
                              <td colSpan={6} className="p-0">
                                <pre className="p-4 bg-slate-950 text-xs text-slate-300 font-mono overflow-x-auto max-h-64 overflow-y-auto">
                                  {deployment.logs}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>
                {deploymentPagination.totalPages > 1 && (
                  <div className="mt-4">
                    <Pagination
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
              <p className="text-slate-400">No deployments yet</p>
            )}
          </div>

      {/* Health Check History */}
      <div className="panel mt-5">
            <h3 className="text-lg font-semibold text-white mb-4">
              Health Check History
            </h3>
            {healthCheckHistory.length > 0 ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                        <th className="pb-3 font-medium">Time</th>
                        <th className="pb-3 font-medium">Status</th>
                        <th className="pb-3 font-medium">Container</th>
                        <th className="pb-3 font-medium">URL Check</th>
                        <th className="pb-3 font-medium">User</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                      {healthPagination.paginatedData.map((log) => {
                        const details = log.details ? JSON.parse(log.details) : null;
                        return (
                          <tr key={log.id} className="text-slate-300">
                            <td className="py-3 text-sm">
                              {format(new Date(log.createdAt), 'MMM d, HH:mm:ss')}
                            </td>
                            <td className="py-3">
                              {log.success ? (
                                <span
                                  className={`badge ${
                                    details?.status === 'healthy'
                                      ? 'badge-success'
                                      : details?.status === 'running'
                                      ? 'badge-info'
                                      : details?.status === 'unhealthy'
                                      ? 'badge-error'
                                      : 'badge-warning'
                                  }`}
                                >
                                  {details?.status || 'unknown'}
                                </span>
                              ) : (
                                <span className="badge badge-error">failed</span>
                              )}
                            </td>
                            <td className="py-3 text-sm">
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
                                <span className="text-slate-500">-</span>
                              )}
                            </td>
                            <td className="py-3 text-sm">
                              {details?.urlHealth ? (
                                <span
                                  className={details.urlHealth.success ? 'text-green-400' : 'text-red-400'}
                                >
                                  {details.urlHealth.success ? 'OK' : 'Failed'}
                                  {details.urlHealth.statusCode && ` (${details.urlHealth.statusCode})`}
                                </span>
                              ) : (
                                <span className="text-slate-500">-</span>
                              )}
                            </td>
                            <td className="py-3 text-sm text-slate-400">
                              {log.user?.email || 'System'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {healthPagination.totalPages > 1 && (
                  <div className="mt-4">
                    <Pagination
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
              <p className="text-slate-400">No health checks recorded yet</p>
            )}
          </div>

      {/* Action History */}
      <div className="panel mt-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">Action History</h3>
          {actionHistory.length > 5 && (
            <button
              onClick={() => setShowAllHistory(!showAllHistory)}
              className="text-sm text-primary-400 hover:text-primary-300"
            >
              {showAllHistory ? 'Show Less' : `Show All (${actionHistory.length})`}
            </button>
          )}
        </div>
        {actionHistory.length > 0 ? (
          <div className="space-y-2">
            {(showAllHistory ? actionHistory : actionHistory.slice(0, 5)).map((log) => {
              const details = log.details ? JSON.parse(log.details) : null;
              return (
                <div
                  key={log.id}
                  className={`flex items-center justify-between p-3 rounded-lg ${
                    log.success ? 'bg-slate-800/50' : 'bg-red-500/10'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {/* Action icon */}
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      log.action === 'deploy' ? 'bg-blue-500/20 text-blue-400' :
                      log.action === 'restart' ? 'bg-yellow-500/20 text-yellow-400' :
                      log.action === 'health_check' ? 'bg-green-500/20 text-green-400' :
                      log.action === 'update' ? 'bg-purple-500/20 text-purple-400' :
                      'bg-slate-600 text-slate-400'
                    }`}>
                      {log.action === 'deploy' && (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                        </svg>
                      )}
                      {log.action === 'restart' && (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      )}
                      {log.action === 'health_check' && (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      )}
                      {log.action === 'update' && (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      )}
                      {log.action === 'create' && (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                        </svg>
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-white font-medium capitalize">{log.action.replace('_', ' ')}</span>
                        {!log.success && (
                          <span className="badge badge-error text-xs">failed</span>
                        )}
                        {log.action === 'deploy' && details?.imageTag && (
                          <span className="text-xs text-primary-400 font-mono">{details.imageTag}</span>
                        )}
                        {log.action === 'health_check' && details?.status && (
                          <span className={`badge text-xs ${getHealthStatusColor(details.healthStatus || details.status)}`}>
                            {details.healthStatus || details.status}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400">
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
          <p className="text-slate-400">No actions recorded yet</p>
        )}
      </div>

      {/* Attach File Modal */}
      {showAttachFile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Attach Config File</h3>
            <form onSubmit={handleAttachFile} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Config File</label>
                <div className="flex gap-2">
                  <select
                    value={attachConfigFileId}
                    onChange={(e) => {
                      setAttachConfigFileId(e.target.value);
                      // Auto-suggest target path based on selected file
                      const selected = configFiles.find((f) => f.id === e.target.value);
                      if (selected && !attachTargetPath) {
                        const defaultPath = service?.composePath
                          ? service.composePath.replace(/[^/]+$/, selected.filename)
                          : `/opt/app/${selected.filename}`;
                        setAttachTargetPath(defaultPath);
                      }
                    }}
                    className="input flex-1"
                    required
                  >
                    <option value="">Select a file...</option>
                    {configFiles
                      .filter((f) => !attachedFiles.some((af) => af.configFileId === f.id))
                      .map((file) => (
                        <option key={file.id} value={file.id}>
                          {file.name} ({file.filename})
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setShowCreateFile(true)}
                    className="btn btn-secondary whitespace-nowrap"
                  >
                    Create New
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Target Path on Server</label>
                <input
                  type="text"
                  value={attachTargetPath}
                  onChange={(e) => setAttachTargetPath(e.target.value)}
                  placeholder="/opt/app/docker-compose.yml"
                  className="input font-mono text-sm"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">
                  Full path where the file will be written on the server
                </p>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowAttachFile(false)}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={attaching} className="btn btn-primary">
                  {attaching ? 'Attaching...' : 'Attach'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* View File Content Modal */}
      {viewingFileContent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-4xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-slate-700">
              <div>
                <h3 className="text-lg font-semibold text-white">{viewingFileContent.name}</h3>
                <p className="text-sm text-slate-400">{viewingFileContent.filename}</p>
              </div>
              <button
                onClick={() => setViewingFileContent(null)}
                className="text-slate-400 hover:text-white"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="text-sm font-mono text-slate-300 whitespace-pre-wrap">
                {viewingFileContent.content}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Create New Config File Modal */}
      {showCreateFile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-3xl p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-white mb-4">Create New Config File</h3>
            <form onSubmit={handleCreateNewFile} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Display Name</label>
                  <input
                    type="text"
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    placeholder="my-config"
                    className="input"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Filename</label>
                  <input
                    type="text"
                    value={newFileFilename}
                    onChange={(e) => setNewFileFilename(e.target.value)}
                    placeholder="config.yml"
                    className="input"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Description (optional)</label>
                <input
                  type="text"
                  value={newFileDescription}
                  onChange={(e) => setNewFileDescription(e.target.value)}
                  placeholder="Description..."
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Content</label>
                <textarea
                  value={newFileContent}
                  onChange={(e) => setNewFileContent(e.target.value)}
                  placeholder="Paste file content here..."
                  rows={12}
                  className="input font-mono text-sm"
                  required
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowCreateFile(false)}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={creatingFile} className="btn btn-primary">
                  {creatingFile ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Config Modal */}
      {showConfig && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">
              Configure Service
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Compose Path
                </label>
                <input
                  type="text"
                  value={editComposePath}
                  onChange={(e) => setEditComposePath(e.target.value)}
                  placeholder="/opt/myservice/docker-compose.yml"
                  className="input font-mono text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Path to docker-compose.yml on the server
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Container Name
                </label>
                <input
                  type="text"
                  value={editContainerName}
                  onChange={(e) => setEditContainerName(e.target.value)}
                  placeholder="my-container"
                  className="input font-mono text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Docker container name for logs and health checks
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Image Name
                </label>
                <input
                  type="text"
                  value={editImageName}
                  onChange={(e) => setEditImageName(e.target.value)}
                  placeholder="registry.example.com/my-image"
                  className="input font-mono text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Docker image name (without tag)
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Health Check URL
                </label>
                <input
                  type="text"
                  value={editHealthCheckUrl}
                  onChange={(e) => setEditHealthCheckUrl(e.target.value)}
                  placeholder="http://localhost:8000/health"
                  className="input font-mono text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">
                  URL to check during health checks (from the server)
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Registry Connection
                </label>
                <select
                  value={editRegistryConnectionId}
                  onChange={(e) => setEditRegistryConnectionId(e.target.value)}
                  className="input"
                >
                  <option value="">None</option>
                  {registries.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} {r.isDefault ? '(default)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  Registry to check for image updates
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Service Type
                </label>
                <select
                  value={editServiceTypeId}
                  onChange={(e) => setEditServiceTypeId(e.target.value)}
                  className="input"
                >
                  <option value="">None</option>
                  {serviceTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.displayName}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  Predefined commands for this service type (Django, Node.js, etc.)
                </p>
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-6">
              <button
                onClick={() => setShowConfig(false)}
                className="btn btn-ghost"
              >
                Cancel
              </button>
              <button
                onClick={saveConfig}
                disabled={saving}
                className="btn btn-primary"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Logs Modal */}
      {showLogs && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-4xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-slate-700">
              <h3 className="text-lg font-semibold text-white">
                Logs - {service.containerName}
              </h3>
              <button
                onClick={() => setShowLogs(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <pre className="flex-1 p-4 overflow-auto font-mono text-sm text-slate-300 bg-slate-950">
              {logs || 'No logs available'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

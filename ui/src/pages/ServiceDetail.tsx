import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  getService,
  deployService,
  restartService,
  deleteService,
  getServiceLogs,
  getDeploymentHistory,
  updateService,
  listEnvTemplates,
  checkServiceHealth,
  listServiceFiles,
  listConfigFiles,
  attachServiceFile,
  detachServiceFile,
  syncServiceFiles,
  checkServiceUpdates,
  listRegistryConnections,
  type ServiceWithServer,
  type Deployment,
  type EnvTemplate,
  type ServiceFile,
  type ConfigFile,
  type SyncResult,
  type RegistryConnection,
} from '../lib/api';
import { useAppStore } from '../lib/store';
import { formatDistanceToNow, format } from 'date-fns';

export default function ServiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { selectedEnvironment } = useAppStore();
  const [service, setService] = useState<ServiceWithServer | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [templates, setTemplates] = useState<EnvTemplate[]>([]);
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

  // Config edit state
  const [editEnvTemplate, setEditEnvTemplate] = useState<string>('');
  const [editComposePath, setEditComposePath] = useState<string>('');
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

  // Registry and auto-update state
  const [registries, setRegistries] = useState<RegistryConnection[]>([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<{
    hasUpdate: boolean;
    latestTag?: string;
  } | null>(null);
  const [togglingAutoUpdate, setTogglingAutoUpdate] = useState(false);

  useEffect(() => {
    if (id) {
      setLoading(true);
      Promise.all([
        getService(id).then(({ service }) => {
          setService(service);
          setImageTag(service.imageTag);
        }),
        getDeploymentHistory(id).then(({ deployments }) => setDeployments(deployments)),
        listEnvTemplates().then(({ templates }) => setTemplates(templates)),
        listServiceFiles(id).then(({ files }) => setAttachedFiles(files)),
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

  const handleDeploy = async () => {
    if (!id) return;
    setDeploying(true);
    try {
      const result = await deployService(id, { imageTag, pullImage: true });
      setDeployments((prev) => [result.deployment, ...prev]);
      if (service) {
        setService({ ...service, imageTag, status: 'running' });
      }
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
    try {
      const result = await checkServiceHealth(id);
      setService((prev) =>
        prev ? { ...prev, status: result.status, lastCheckedAt: result.lastCheckedAt } : null
      );
    } finally {
      setChecking(false);
    }
  };

  const loadLogs = async () => {
    if (!id) return;
    const { logs } = await getServiceLogs(id, 200);
    setLogs(logs);
    setShowLogs(true);
  };

  const openConfig = () => {
    if (!service) return;
    setEditEnvTemplate(service.envTemplateName || '');
    setEditComposePath(service.composePath || '');
    setEditHealthCheckUrl(service.healthCheckUrl || '');
    setEditRegistryConnectionId(service.registryConnectionId || '');
    setShowConfig(true);
  };

  const saveConfig = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const { service: updated } = await updateService(id, {
        envTemplateName: editEnvTemplate || null,
        composePath: editComposePath || null,
        healthCheckUrl: editHealthCheckUrl || null,
        registryConnectionId: editRegistryConnectionId || null,
      });
      setService((prev) => (prev ? { ...prev, ...updated } : null));
      setShowConfig(false);
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

  if (!service) {
    return (
      <div className="p-8">
        <div className="card text-center py-12">
          <p className="text-slate-400">Service not found</p>
          <Link to="/services" className="btn btn-primary mt-4">
            Back to Services
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Missing Service Warning */}
      {service.discoveryStatus === 'missing' && (
        <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4 mb-6">
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

      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="flex items-center gap-3">
            <span
              className={`badge ${
                service.discoveryStatus === 'missing'
                  ? 'badge-warning'
                  : service.status === 'running' || service.status === 'healthy'
                  ? 'badge-success'
                  : service.status === 'stopped'
                  ? 'badge-error'
                  : 'badge-warning'
              }`}
            >
              {service.discoveryStatus === 'missing' ? 'missing' : service.status}
            </span>
            <h1 className="text-2xl font-bold text-white">{service.name}</h1>
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
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 mb-6">
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

      <div className="grid grid-cols-3 gap-6 mb-8">
        {/* Deploy Card */}
        <div className="col-span-2 card">
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
            <div>
              <label className="block text-sm text-slate-400 mb-1">
                Image Tag
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
            <div className="text-sm text-slate-400">
              <p>Current image:</p>
              <code className="text-primary-400">
                {service.imageName}:{service.imageTag}
              </code>
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
          </div>
        </div>

        {/* Service Info */}
        <div className="card">
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
            <div>
              <dt className="text-slate-400">Env Template</dt>
              <dd className={service.envTemplateName ? 'text-primary-400 font-mono' : 'text-slate-500'}>
                {service.envTemplateName || 'Not configured'}
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

      {/* Deployment History */}
      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-4">
          Deployment History
        </h3>
        {deployments.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                  <th className="pb-3 font-medium">Tag</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Triggered By</th>
                  <th className="pb-3 font-medium">Started</th>
                  <th className="pb-3 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {deployments.map((deployment) => (
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-slate-400">No deployments yet</p>
        )}
      </div>

      {/* Attached Files */}
      <div className="card mt-6">
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
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium">{file.configFile.name}</span>
                    <span className="text-xs text-slate-500">({file.configFile.filename})</span>
                  </div>
                  <code className="text-sm text-green-400">{file.targetPath}</code>
                </div>
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
            ))}
          </div>
        ) : (
          <p className="text-slate-400 text-sm">
            No config files attached. Attach files to sync docker-compose, Caddyfile, certificates, etc.
          </p>
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
                  className="input"
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
                  Env Template
                </label>
                <select
                  value={editEnvTemplate}
                  onChange={(e) => setEditEnvTemplate(e.target.value)}
                  className="input"
                >
                  <option value="">None</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  Template used to generate .env file during deployment
                </p>
              </div>
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

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store.js';
import { useToast } from '../components/Toast.js';
import {
  listRegistryConnections,
  createRegistryConnection,
  updateRegistryConnection,
  deleteRegistryConnection,
  testRegistryConnection,
  getRegistryServices,
  checkRegistryUpdates,
  deployService,
  type RegistryConnection,
  type RegistryConnectionInput,
  type RegistryService,
} from '../lib/api.js';
import { formatDistanceToNow } from 'date-fns';
import Pagination from '../components/Pagination.js';
import { usePagination } from '../hooks/usePagination.js';
import { RegistryIcon } from '../components/Icons.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { EmptyState } from '../components/EmptyState.js';

const REGISTRY_TYPES = [
  { value: 'digitalocean', label: 'DigitalOcean', url: 'https://api.digitalocean.com/v2/registry' },
  { value: 'dockerhub', label: 'Docker Hub', url: 'https://hub.docker.com' },
  { value: 'generic', label: 'Generic Registry', url: '' },
] as const;

export default function Registries() {
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const [registries, setRegistries] = useState<RegistryConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);
  const [viewingServices, setViewingServices] = useState<string | null>(null);
  const [linkedServices, setLinkedServices] = useState<RegistryService[]>([]);
  const [loadingServices, setLoadingServices] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState<string | null>(null);
  const [updatingService, setUpdatingService] = useState<string | null>(null);

  // Form state
  const [formData, setFormData] = useState<RegistryConnectionInput>({
    name: '',
    type: 'digitalocean',
    registryUrl: 'https://api.digitalocean.com/v2/registry',
    repositoryPrefix: '',
    token: '',
    username: '',
    password: '',
    isDefault: false,
    refreshIntervalMinutes: 30,
    autoLinkPattern: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      listRegistryConnections(selectedEnvironment.id)
        .then(({ registries }) => setRegistries(registries))
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id]);

  const resetForm = () => {
    setFormData({
      name: '',
      type: 'digitalocean',
      registryUrl: 'https://api.digitalocean.com/v2/registry',
      repositoryPrefix: '',
      token: '',
      username: '',
      password: '',
      isDefault: false,
      refreshIntervalMinutes: 30,
      autoLinkPattern: '',
    });
  };

  const openCreate = () => {
    resetForm();
    setEditingId(null);
    setShowCreate(true);
  };

  const openEdit = (registry: RegistryConnection) => {
    setFormData({
      name: registry.name,
      type: registry.type,
      registryUrl: registry.registryUrl,
      repositoryPrefix: registry.repositoryPrefix || '',
      token: '', // Don't show existing token
      username: registry.username || '',
      password: '', // Don't show existing password
      isDefault: registry.isDefault,
      refreshIntervalMinutes: registry.refreshIntervalMinutes,
      autoLinkPattern: registry.autoLinkPattern || '',
    });
    setEditingId(registry.id);
    setShowCreate(true);
  };

  const handleTypeChange = (type: 'digitalocean' | 'dockerhub' | 'generic') => {
    const typeConfig = REGISTRY_TYPES.find((t) => t.value === type);
    setFormData({
      ...formData,
      type,
      registryUrl: typeConfig?.url || '',
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;

    setSaving(true);
    try {
      // Clean up empty optional fields
      const data: RegistryConnectionInput = {
        name: formData.name,
        type: formData.type,
        registryUrl: formData.registryUrl,
        isDefault: formData.isDefault,
        refreshIntervalMinutes: formData.refreshIntervalMinutes,
      };
      if (formData.repositoryPrefix) data.repositoryPrefix = formData.repositoryPrefix;
      if (formData.token) data.token = formData.token;
      if (formData.username) data.username = formData.username;
      if (formData.password) data.password = formData.password;
      if (formData.autoLinkPattern) data.autoLinkPattern = formData.autoLinkPattern;

      if (editingId) {
        const { registry } = await updateRegistryConnection(editingId, data);
        setRegistries((prev) =>
          prev.map((r) => (r.id === editingId ? registry : r))
        );
      } else {
        const { registry } = await createRegistryConnection(selectedEnvironment.id, data);
        setRegistries((prev) => [...prev, registry]);
      }
      setShowCreate(false);
      resetForm();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const registry = registries.find((r) => r.id === id);
    if (!registry) return;
    if (!confirm(`Delete registry connection "${registry.name}"?`)) return;

    try {
      await deleteRegistryConnection(id);
      setRegistries((prev) => prev.filter((r) => r.id !== id));
      toast.success('Registry deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    setTestResult(null);
    try {
      const result = await testRegistryConnection(id);
      setTestResult({
        id,
        success: result.success,
        message: result.success ? 'Connection successful' : result.error || 'Connection failed',
      });
    } catch (error) {
      setTestResult({
        id,
        success: false,
        message: error instanceof Error ? error.message : 'Test failed',
      });
    } finally {
      setTesting(null);
    }
  };

  const handleViewServices = async (id: string) => {
    if (viewingServices === id) {
      setViewingServices(null);
      setLinkedServices([]);
      return;
    }
    setViewingServices(id);
    setLoadingServices(true);
    try {
      const { services } = await getRegistryServices(id);
      setLinkedServices(services);
    } catch (error) {
      toast.error('Failed to load linked services');
    } finally {
      setLoadingServices(false);
    }
  };

  const handleCheckUpdates = async (id: string) => {
    setCheckingUpdates(id);
    try {
      const result = await checkRegistryUpdates(id);
      toast.success(
        `Checked ${result.summary.checked} services: ${result.summary.withUpdates} with updates`
      );
      // Refresh services list if viewing
      if (viewingServices === id) {
        const { services } = await getRegistryServices(id);
        setLinkedServices(services);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to check updates');
    } finally {
      setCheckingUpdates(null);
    }
  };

  const handleUpdateService = async (service: RegistryService) => {
    if (!service.latestAvailableTag) return;
    setUpdatingService(service.id);
    try {
      await deployService(service.id, { imageTag: service.latestAvailableTag, pullImage: true });
      toast.success(`Updated ${service.name} to ${service.latestAvailableTag}`);
      // Refresh services list
      if (viewingServices) {
        const { services } = await getRegistryServices(viewingServices);
        setLinkedServices(services);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Update failed');
    } finally {
      setUpdatingService(null);
    }
  };

  const handleUnlinkService = async (service: RegistryService) => {
    // Registry connection is now managed through ContainerImage, not Service directly
    // To unlink, edit the ContainerImage's registry connection instead
    toast.error('To change registry, edit the Container Image settings');
    void service; // Suppress unused warning
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
  } = usePagination({ data: registries, defaultPageSize: 25 });

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-slate-400">Select an environment to view registries</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Manage container registry connections for {selectedEnvironment.name}
        </p>
        <button onClick={openCreate} className="btn btn-primary">
          Add Registry
        </button>
      </div>

      {loading ? (
        <LoadingSkeleton rows={2} rowHeight="h-12" />
      ) : registries.length === 0 ? (
        <EmptyState
          icon={RegistryIcon}
          message="No registry connections configured"
          description="Connect a container registry to enable automatic update checking for services"
          action={{ label: 'Add Your First Registry', onClick: openCreate }}
        />
      ) : (
        <div className="space-y-4">
          {paginatedData.map((registry) => (
            <div key={registry.id} className="panel">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-slate-800 rounded-lg">
                    <RegistryIcon className="w-6 h-6 text-primary-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-white">{registry.name}</h3>
                      {registry.isDefault && (
                        <span className="badge badge-info text-xs">Default</span>
                      )}
                      <span className="badge bg-slate-700 text-slate-300 text-xs">
                        {REGISTRY_TYPES.find((t) => t.value === registry.type)?.label || registry.type}
                      </span>
                    </div>
                    <p className="text-slate-400 text-sm mt-1 font-mono">{registry.registryUrl}</p>
                    {registry.repositoryPrefix && (
                      <p className="text-slate-500 text-sm">Prefix: {registry.repositoryPrefix}</p>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                      <span>
                        {registry._count?.services || 0} service{registry._count?.services !== 1 ? 's' : ''}
                      </span>
                      <span>Refresh: {registry.refreshIntervalMinutes}m</span>
                      {registry.autoLinkPattern && (
                        <span className="text-primary-400">Auto-link: {registry.autoLinkPattern}</span>
                      )}
                      <span>
                        Updated {formatDistanceToNow(new Date(registry.updatedAt), { addSuffix: true })}
                      </span>
                    </div>
                    {testResult?.id === registry.id && (
                      <div
                        className={`mt-2 text-sm ${
                          testResult.success ? 'text-green-400' : 'text-red-400'
                        }`}
                      >
                        {testResult.message}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  {(registry._count?.services || 0) > 0 && (
                    <>
                      <button
                        onClick={() => handleCheckUpdates(registry.id)}
                        disabled={checkingUpdates === registry.id}
                        className="btn btn-secondary text-sm"
                      >
                        {checkingUpdates === registry.id ? 'Checking...' : 'Check Updates'}
                      </button>
                      <button
                        onClick={() => handleViewServices(registry.id)}
                        className="btn btn-ghost text-sm"
                      >
                        {viewingServices === registry.id ? 'Hide Services' : 'View Services'}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => handleTest(registry.id)}
                    disabled={testing === registry.id}
                    className="btn btn-ghost text-sm"
                  >
                    {testing === registry.id ? 'Testing...' : 'Test'}
                  </button>
                  <button
                    onClick={() => openEdit(registry)}
                    className="btn btn-ghost text-sm"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(registry.id)}
                    className="btn btn-ghost text-sm text-red-400 hover:text-red-300"
                    disabled={(registry._count?.services || 0) > 0}
                    title={
                      (registry._count?.services || 0) > 0
                        ? 'Cannot delete registry with attached services'
                        : ''
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Linked Services */}
              {viewingServices === registry.id && (
                <div className="mt-4 pt-4 border-t border-slate-700">
                  <h4 className="text-sm font-medium text-slate-400 mb-3">Linked Services</h4>
                  {loadingServices ? (
                    <div className="animate-pulse space-y-2">
                      <div className="h-8 bg-slate-700 rounded"></div>
                      <div className="h-8 bg-slate-700 rounded"></div>
                    </div>
                  ) : linkedServices.length === 0 ? (
                    <p className="text-sm text-slate-500">No services linked to this registry</p>
                  ) : (
                    <div className="space-y-2">
                      {linkedServices.map((service) => {
                        const hasUpdate = service.latestAvailableTag && service.latestAvailableTag !== service.imageTag;
                        return (
                          <div
                            key={service.id}
                            className="flex items-center justify-between p-3 bg-slate-800/50 rounded"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Link
                                  to={`/services/${service.id}`}
                                  className="text-white hover:text-primary-400 font-medium"
                                >
                                  {service.name}
                                </Link>
                                <span className="text-slate-500 text-sm">on {service.server.name}</span>
                                {service.autoUpdate && (
                                  <span className="badge bg-primary-500/20 text-primary-400 text-xs">Auto-update</span>
                                )}
                                {hasUpdate && (
                                  <span className="badge bg-yellow-500/20 text-yellow-400 text-xs">Update available</span>
                                )}
                              </div>
                              <p className="text-xs text-slate-400 font-mono mt-1 truncate">
                                {service.containerImage?.imageName}
                              </p>
                              <div className="flex items-center gap-4 mt-1 text-xs text-slate-500">
                                <span className="font-mono">
                                  Current: <span className="text-slate-300">{service.imageTag}</span>
                                </span>
                                {service.latestAvailableTag && (
                                  <span className="font-mono">
                                    Latest: <span className={hasUpdate ? 'text-yellow-400' : 'text-slate-300'}>
                                      {service.latestAvailableTag}
                                    </span>
                                  </span>
                                )}
                                {service.lastUpdateCheckAt && (
                                  <span>
                                    Checked {formatDistanceToNow(new Date(service.lastUpdateCheckAt), { addSuffix: true })}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                              {hasUpdate && (
                                <button
                                  onClick={() => handleUpdateService(service)}
                                  disabled={updatingService === service.id}
                                  className="btn btn-sm btn-primary"
                                >
                                  {updatingService === service.id ? 'Updating...' : 'Update'}
                                </button>
                              )}
                              <button
                                onClick={() => handleUnlinkService(service)}
                                className="btn btn-sm btn-ghost text-slate-400 hover:text-red-400"
                                title="Unlink from registry"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={totalItems}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      )}

      {/* Create/Edit Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingId ? 'Edit Registry Connection' : 'Add Registry Connection'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="My Registry"
                  className="input"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Type</label>
                <select
                  value={formData.type}
                  onChange={(e) =>
                    handleTypeChange(e.target.value as 'digitalocean' | 'dockerhub' | 'generic')
                  }
                  className="input"
                >
                  {REGISTRY_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Registry URL</label>
                <input
                  type="text"
                  value={formData.registryUrl}
                  onChange={(e) => setFormData({ ...formData, registryUrl: e.target.value })}
                  placeholder="https://registry.example.com"
                  className="input font-mono text-sm"
                  required
                />
              </div>

              {formData.type === 'digitalocean' && (
                <div>
                  <label className="block text-sm text-slate-400 mb-1">
                    Repository Prefix (Registry Name)
                  </label>
                  <input
                    type="text"
                    value={formData.repositoryPrefix}
                    onChange={(e) => setFormData({ ...formData, repositoryPrefix: e.target.value })}
                    placeholder="bios-registry"
                    className="input font-mono text-sm"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    The registry name from DigitalOcean (e.g., bios-registry)
                  </p>
                </div>
              )}

              {formData.type === 'digitalocean' && (
                <div>
                  <label className="block text-sm text-slate-400 mb-1">API Token</label>
                  <input
                    type="password"
                    value={formData.token}
                    onChange={(e) => setFormData({ ...formData, token: e.target.value })}
                    placeholder={editingId ? '(unchanged)' : 'dop_v1_...'}
                    className="input font-mono text-sm"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    DigitalOcean API token with registry read access
                  </p>
                </div>
              )}

              {(formData.type === 'dockerhub' || formData.type === 'generic') && (
                <>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Username</label>
                    <input
                      type="text"
                      value={formData.username}
                      onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                      placeholder="username"
                      className="input"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Password / Token</label>
                    <input
                      type="password"
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      placeholder={editingId ? '(unchanged)' : 'password or access token'}
                      className="input"
                    />
                  </div>
                </>
              )}

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isDefault"
                  checked={formData.isDefault}
                  onChange={(e) => setFormData({ ...formData, isDefault: e.target.checked })}
                  className="rounded bg-slate-700 border-slate-600 text-primary-500 focus:ring-primary-500"
                />
                <label htmlFor="isDefault" className="text-sm text-slate-300">
                  Set as default registry for this environment
                </label>
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Refresh Interval (minutes)</label>
                <input
                  type="number"
                  min={5}
                  max={1440}
                  value={formData.refreshIntervalMinutes}
                  onChange={(e) =>
                    setFormData({ ...formData, refreshIntervalMinutes: parseInt(e.target.value) || 30 })
                  }
                  className="input"
                />
                <p className="text-xs text-slate-500 mt-1">
                  How often to check for image updates (5-1440 minutes)
                </p>
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Auto-link Pattern (optional)</label>
                <input
                  type="text"
                  value={formData.autoLinkPattern}
                  onChange={(e) => setFormData({ ...formData, autoLinkPattern: e.target.value })}
                  placeholder="bios-*"
                  className="input font-mono text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Automatically link services matching this pattern (e.g., "bios-*", "app-*")
                </p>
              </div>

              <div className="flex gap-2 justify-end pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    resetForm();
                    setEditingId(null);
                  }}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="btn btn-primary">
                  {saving ? 'Saving...' : editingId ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

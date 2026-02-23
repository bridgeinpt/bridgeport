import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import {
  listContainerImages,
  createContainerImage,
  updateContainerImage,
  updateContainerImageSettings,
  deleteContainerImage,
  deployContainerImage,
  getContainerImageHistory,
  linkServiceToContainerImage,
  getLinkableServices,
  listRegistryConnections,
  checkContainerImageUpdates,
  type ContainerImage,
  type ContainerImageInput,
  type ContainerImageHistory,
  type Service,
  type RegistryConnection,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';
import { PencilIcon, TrashIcon } from '../components/Icons';
import Pagination from '../components/Pagination';

export default function ContainerImages() {
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const [images, setImages] = useState<ContainerImage[]>([]);
  const [registries, setRegistries] = useState<RegistryConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Deploy modal
  const [deployingImage, setDeployingImage] = useState<ContainerImage | null>(null);
  const [deployTag, setDeployTag] = useState('');
  const [deployAutoRollback, setDeployAutoRollback] = useState(true);
  const [deploying, setDeploying] = useState(false);

  // History modal
  const [viewingHistory, setViewingHistory] = useState<string | null>(null);
  const [history, setHistory] = useState<ContainerImageHistory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Link services
  const [linkingImage, setLinkingImage] = useState<ContainerImage | null>(null);
  const [linkableServices, setLinkableServices] = useState<Service[]>([]);
  const [loadingLinkable, setLoadingLinkable] = useState(false);

  // Pagination
  const [totalItems, setTotalItems] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Check updates state
  const [checkingUpdatesId, setCheckingUpdatesId] = useState<string | null>(null);

  // Edit form auto-update state
  const [editAutoUpdate, setEditAutoUpdate] = useState(false);

  // Form state
  const [formData, setFormData] = useState<ContainerImageInput>({
    name: '',
    imageName: '',
    currentTag: 'latest',
    registryConnectionId: null,
  });

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      const offset = (currentPage - 1) * pageSize;
      Promise.all([
        listContainerImages(selectedEnvironment.id, { limit: pageSize, offset }),
        listRegistryConnections(selectedEnvironment.id),
      ])
        .then(([imagesRes, registriesRes]) => {
          setImages(imagesRes.images);
          setTotalItems(imagesRes.total);
          setRegistries(registriesRes.registries);
        })
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id, currentPage, pageSize]);

  const reloadImages = async () => {
    if (!selectedEnvironment?.id) return;
    const offset = (currentPage - 1) * pageSize;
    const res = await listContainerImages(selectedEnvironment.id, { limit: pageSize, offset });
    setImages(res.images);
    setTotalItems(res.total);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      imageName: '',
      currentTag: 'latest',
      registryConnectionId: null,
    });
    setEditAutoUpdate(false);
  };

  const openCreate = () => {
    resetForm();
    setEditingId(null);
    setShowCreate(true);
  };

  const openEdit = (image: ContainerImage) => {
    setFormData({
      name: image.name,
      imageName: image.imageName,
      currentTag: image.currentTag,
      registryConnectionId: image.registryConnectionId,
    });
    setEditAutoUpdate(image.autoUpdate);
    setEditingId(image.id);
    setShowCreate(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;

    setSaving(true);
    try {
      if (editingId) {
        await updateContainerImage(editingId, formData);
        // Also update autoUpdate setting if it has a registry
        if (formData.registryConnectionId) {
          await updateContainerImageSettings(editingId, { autoUpdate: editAutoUpdate });
        }
        toast.success('Image updated');
      } else {
        await createContainerImage(selectedEnvironment.id, formData);
        toast.success('Image created');
      }
      await reloadImages();
      setShowCreate(false);
      resetForm();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const image = images.find((i) => i.id === id);
    if (!image) return;
    if (!confirm(`Delete container image "${image.name}"? Services linked to this image cannot be deleted.`)) return;

    try {
      await deleteContainerImage(id);
      toast.success('Image deleted');
      await reloadImages();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const openDeployModal = (image: ContainerImage) => {
    setDeployingImage(image);
    setDeployTag(image.latestTag || image.currentTag);
    setDeployAutoRollback(true);
  };

  const handleDeploy = async () => {
    if (!deployingImage || !deployTag) return;

    setDeploying(true);
    try {
      const { plan } = await deployContainerImage(deployingImage.id, deployTag, deployAutoRollback);
      toast.success(`Deployment plan created: ${plan.name}`);
      setDeployingImage(null);
      await reloadImages();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Deployment failed');
    } finally {
      setDeploying(false);
    }
  };

  const handleViewHistory = async (imageId: string) => {
    if (viewingHistory === imageId) {
      setViewingHistory(null);
      setHistory([]);
      return;
    }
    setViewingHistory(imageId);
    setLoadingHistory(true);
    try {
      const { history } = await getContainerImageHistory(imageId);
      setHistory(history);
    } catch (error) {
      toast.error('Failed to load history');
    } finally {
      setLoadingHistory(false);
    }
  };

  const openLinkModal = async (image: ContainerImage) => {
    setLinkingImage(image);
    setLoadingLinkable(true);
    try {
      const { services } = await getLinkableServices(image.id);
      setLinkableServices(services);
    } catch (error) {
      toast.error('Failed to load services');
    } finally {
      setLoadingLinkable(false);
    }
  };

  const handleLinkService = async (serviceId: string) => {
    if (!linkingImage) return;
    try {
      await linkServiceToContainerImage(linkingImage.id, serviceId);
      toast.success('Service linked');
      await reloadImages();
      const { services } = await getLinkableServices(linkingImage.id);
      setLinkableServices(services);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to link');
    }
  };

  const handleCheckUpdates = async (imageId: string) => {
    setCheckingUpdatesId(imageId);
    try {
      const result = await checkContainerImageUpdates(imageId);
      await reloadImages();
      if (result.hasUpdate) {
        toast.success(`Update available: ${result.latestTag}`);
      } else {
        toast.success('No updates available');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to check updates');
    } finally {
      setCheckingUpdatesId(null);
    }
  };

  // Helper function to get status badge color
  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'success':
        return 'bg-green-500/20 text-green-400';
      case 'failed':
        return 'bg-red-500/20 text-red-400';
      case 'rolled_back':
        return 'bg-yellow-500/20 text-yellow-400';
      default:
        return 'bg-slate-700 text-slate-300';
    }
  };

  const totalPages = Math.ceil(totalItems / pageSize);

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-slate-400">Select an environment to view container images</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Central image management for orchestrated deployments
        </p>
        <button onClick={openCreate} className="btn btn-primary">
          Add Container Image
        </button>
      </div>

      {loading ? (
        <div className="panel">
          <div className="animate-pulse space-y-4">
            <div className="h-12 bg-slate-700 rounded"></div>
            <div className="h-12 bg-slate-700 rounded"></div>
          </div>
        </div>
      ) : totalItems === 0 ? (
        <div className="panel text-center py-12">
          <ImageIcon className="w-12 h-12 text-slate-500 mx-auto mb-4" />
          <p className="text-slate-400 mb-4">No container images configured</p>
          <p className="text-slate-500 text-sm mb-4">
            Create container images to deploy the same image to multiple services with orchestration
          </p>
          <button onClick={openCreate} className="btn btn-primary">
            Add Your First Container Image
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {images.map((image) => (
            <div key={image.id} className="panel">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-slate-800 rounded-lg">
                    <ImageIcon className="w-6 h-6 text-primary-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-white">{image.name}</h3>
                      <span className="badge bg-slate-700 text-slate-300 text-xs font-mono">
                        {image.currentTag}
                      </span>
                      {image.updateAvailable && (
                        <span className="badge bg-yellow-500/20 text-yellow-400 text-xs">
                          {image.latestTag ? `${image.latestTag} available` : 'update available'}
                        </span>
                      )}
                    </div>
                    <p className="text-slate-400 text-sm mt-1 font-mono">{image.imageName}</p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                      <span>
                        {image.services.length} service{image.services.length !== 1 ? 's' : ''} linked
                      </span>
                      {image.registryConnection && (
                        <span className="text-primary-400">
                          Registry: {image.registryConnection.name}
                        </span>
                      )}
                      {image.autoUpdate && (
                        <span className="text-green-400 flex items-center gap-1">
                          <RefreshIcon className="w-3 h-3" />
                          Auto-update enabled
                        </span>
                      )}
                      {image.lastCheckedAt && (
                        <span>
                          Checked {formatDistanceToNow(new Date(image.lastCheckedAt), { addSuffix: true })}
                        </span>
                      )}
                    </div>

                    {/* Linked Services */}
                    {image.services.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {image.services.map((service) => (
                          <div
                            key={service.id}
                            className="flex items-center gap-1 px-2 py-1 bg-slate-800/50 rounded text-xs"
                          >
                            <Link
                              to={`/services/${service.id}`}
                              className="text-slate-300 hover:text-primary-400"
                            >
                              {service.name}
                            </Link>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Check updates button */}
                  {image.registryConnectionId && (
                    <button
                      onClick={() => handleCheckUpdates(image.id)}
                      disabled={checkingUpdatesId === image.id}
                      className="btn btn-ghost text-sm"
                      title="Check for updates from registry"
                    >
                      {checkingUpdatesId === image.id ? (
                        <span className="flex items-center gap-1">
                          <span className="animate-spin">
                            <RefreshIcon className="w-4 h-4" />
                          </span>
                          Checking...
                        </span>
                      ) : (
                        'Check Updates'
                      )}
                    </button>
                  )}
                  {image.services.length > 0 && (
                    <button
                      onClick={() => openDeployModal(image)}
                      className="btn btn-primary text-sm"
                    >
                      Deploy
                    </button>
                  )}
                  <button
                    onClick={() => handleViewHistory(image.id)}
                    className="btn btn-ghost text-sm"
                  >
                    {viewingHistory === image.id ? 'Hide History' : 'History'}
                  </button>
                  <button
                    onClick={() => openLinkModal(image)}
                    className="btn btn-ghost text-sm"
                  >
                    Link Services
                  </button>
                  <button
                    onClick={() => openEdit(image)}
                    className="p-1.5 text-slate-400 hover:text-white rounded"
                    title="Edit"
                  >
                    <PencilIcon className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(image.id)}
                    className="p-1.5 text-slate-400 hover:text-red-400 rounded"
                    title="Delete"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* History */}
              {viewingHistory === image.id && (
                <div className="mt-4 pt-4 border-t border-slate-700">
                  <h4 className="text-sm font-medium text-slate-400 mb-3">Deployment History</h4>
                  {loadingHistory ? (
                    <div className="animate-pulse space-y-2">
                      <div className="h-8 bg-slate-700 rounded"></div>
                    </div>
                  ) : history.length === 0 ? (
                    <p className="text-sm text-slate-500">No deployment history</p>
                  ) : (
                    <div className="space-y-2">
                      {history.slice(0, 10).map((entry) => (
                        <div
                          key={entry.id}
                          className="p-3 bg-slate-800/50 rounded text-sm"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4">
                              <span className="font-mono text-white">{entry.tag}</span>
                              <span className={`badge text-xs ${getStatusBadge(entry.status)}`}>
                                {entry.status}
                              </span>
                              {entry.deploymentCount && entry.deploymentCount > 0 && (
                                <span className="text-slate-500">
                                  {entry.deploymentCount} deployment{entry.deploymentCount !== 1 ? 's' : ''}
                                </span>
                              )}
                              {entry.totalDurationMs && entry.totalDurationMs > 0 && (
                                <span className="text-slate-500">
                                  {Math.round(entry.totalDurationMs / 1000)}s
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-slate-400">
                              <span>{entry.deployedBy}</span>
                              <span className="text-slate-500">
                                {format(new Date(entry.deployedAt), 'MMM d, HH:mm')}
                              </span>
                            </div>
                          </div>
                          {/* Services deployed */}
                          {entry.services && entry.services.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-slate-700 flex flex-wrap gap-2">
                              {entry.services.map((svc) => (
                                <div
                                  key={svc.id}
                                  className="flex items-center gap-1 px-2 py-0.5 bg-slate-700/50 rounded text-xs"
                                >
                                  <span className="text-slate-300">{svc.name}</span>
                                  <span className="text-slate-500">on {svc.serverName}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {totalItems > 0 && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={totalItems}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
        />
      )}

      {/* Create/Edit Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingId ? 'Edit Container Image' : 'Add Container Image'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Display Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="BIOS Backend"
                  className="input"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Image Name</label>
                <input
                  type="text"
                  value={formData.imageName}
                  onChange={(e) => setFormData({ ...formData, imageName: e.target.value })}
                  placeholder="registry.digitalocean.com/bios-registry/bios-backend"
                  className="input font-mono text-sm"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Current Tag</label>
                <input
                  type="text"
                  value={formData.currentTag}
                  onChange={(e) => setFormData({ ...formData, currentTag: e.target.value })}
                  placeholder="latest"
                  className="input font-mono text-sm"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Registry Connection</label>
                <select
                  value={formData.registryConnectionId || ''}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      registryConnectionId: e.target.value || null,
                    })
                  }
                  className="input"
                >
                  <option value="">None</option>
                  {registries.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Auto-update toggle - only shown when editing and has registry */}
              {editingId && formData.registryConnectionId && (
                <div className="flex items-center justify-between pt-2">
                  <div>
                    <label className="block text-sm text-white font-medium">Auto-update</label>
                    <p className="text-xs text-slate-400">
                      Automatically deploy when new tags are detected
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditAutoUpdate(!editAutoUpdate)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      editAutoUpdate ? 'bg-primary-600' : 'bg-slate-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        editAutoUpdate ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              )}

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

      {/* Deploy Modal */}
      {deployingImage && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">
              Deploy {deployingImage.name}
            </h3>
            <p className="text-slate-400 text-sm mb-4">
              This will deploy to {deployingImage.services.length} linked service
              {deployingImage.services.length !== 1 ? 's' : ''} in dependency order.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Image Tag</label>
                <input
                  type="text"
                  value={deployTag}
                  onChange={(e) => setDeployTag(e.target.value)}
                  placeholder="v1.0.0"
                  className="input font-mono"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="autoRollback"
                  checked={deployAutoRollback}
                  onChange={(e) => setDeployAutoRollback(e.target.checked)}
                  className="rounded bg-slate-700 border-slate-600 text-primary-500 focus:ring-primary-500"
                />
                <label htmlFor="autoRollback" className="text-sm text-slate-300">
                  Auto-rollback on failure
                </label>
              </div>

              <div className="bg-slate-800/50 rounded p-3">
                <h4 className="text-sm font-medium text-slate-400 mb-2">Services to deploy:</h4>
                <div className="space-y-1">
                  {deployingImage.services.map((s) => (
                    <div key={s.id} className="text-sm text-slate-300">
                      {s.name}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-4">
                <button
                  type="button"
                  onClick={() => setDeployingImage(null)}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeploy}
                  disabled={deploying || !deployTag}
                  className="btn btn-primary"
                >
                  {deploying ? 'Starting Deploy...' : 'Deploy'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Link Services Modal */}
      {linkingImage && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">
              Link Services to {linkingImage.name}
            </h3>
            <p className="text-slate-400 text-sm mb-4">
              Services that can be linked to this container image
            </p>

            {loadingLinkable ? (
              <div className="animate-pulse space-y-2">
                <div className="h-10 bg-slate-700 rounded"></div>
              </div>
            ) : linkableServices.length === 0 ? (
              <p className="text-slate-500 text-sm">
                No services available to link.
              </p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {linkableServices.map((service) => (
                  <div
                    key={service.id}
                    className="flex items-center justify-between p-3 bg-slate-800/50 rounded"
                  >
                    <div>
                      <span className="text-white">{service.name}</span>
                      <span className="text-slate-500 text-sm ml-2">
                        on {(service as Service & { server: { name: string } }).server?.name}
                      </span>
                    </div>
                    <button
                      onClick={() => handleLinkService(service.id)}
                      className="btn btn-sm btn-primary"
                    >
                      Link
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 justify-end pt-4">
              <button
                onClick={() => {
                  setLinkingImage(null);
                  setLinkableServices([]);
                }}
                className="btn btn-ghost"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
}

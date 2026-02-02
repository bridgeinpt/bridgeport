import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import {
  listManagedImages,
  createManagedImage,
  updateManagedImage,
  deleteManagedImage,
  deployManagedImage,
  getManagedImageHistory,
  linkServiceToManagedImage,
  unlinkServiceFromManagedImage,
  getLinkableServices,
  listRegistryConnections,
  type ManagedImage,
  type ManagedImageInput,
  type ImageTagHistory,
  type Service,
  type RegistryConnection,
} from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

export default function ManagedImages() {
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const [images, setImages] = useState<ManagedImage[]>([]);
  const [registries, setRegistries] = useState<RegistryConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Deploy modal
  const [deployingImage, setDeployingImage] = useState<ManagedImage | null>(null);
  const [deployTag, setDeployTag] = useState('');
  const [deployAutoRollback, setDeployAutoRollback] = useState(true);
  const [deploying, setDeploying] = useState(false);

  // History modal
  const [viewingHistory, setViewingHistory] = useState<string | null>(null);
  const [history, setHistory] = useState<ImageTagHistory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Link services
  const [linkingImage, setLinkingImage] = useState<ManagedImage | null>(null);
  const [linkableServices, setLinkableServices] = useState<Service[]>([]);
  const [loadingLinkable, setLoadingLinkable] = useState(false);

  // Form state
  const [formData, setFormData] = useState<ManagedImageInput>({
    name: '',
    imageName: '',
    currentTag: 'latest',
    registryConnectionId: null,
  });

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      Promise.all([
        listManagedImages(selectedEnvironment.id),
        listRegistryConnections(selectedEnvironment.id),
      ])
        .then(([imagesRes, registriesRes]) => {
          setImages(imagesRes.images);
          setRegistries(registriesRes.registries);
        })
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id]);

  const resetForm = () => {
    setFormData({
      name: '',
      imageName: '',
      currentTag: 'latest',
      registryConnectionId: null,
    });
  };

  const openCreate = () => {
    resetForm();
    setEditingId(null);
    setShowCreate(true);
  };

  const openEdit = (image: ManagedImage) => {
    setFormData({
      name: image.name,
      imageName: image.imageName,
      currentTag: image.currentTag,
      registryConnectionId: image.registryConnectionId,
    });
    setEditingId(image.id);
    setShowCreate(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;

    setSaving(true);
    try {
      if (editingId) {
        const { image } = await updateManagedImage(editingId, formData);
        setImages((prev) => prev.map((i) => (i.id === editingId ? image : i)));
        toast.success('Image updated');
      } else {
        const { image } = await createManagedImage(selectedEnvironment.id, formData);
        setImages((prev) => [...prev, image]);
        toast.success('Image created');
      }
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
    if (!confirm(`Delete managed image "${image.name}"? This will unlink all services.`)) return;

    try {
      await deleteManagedImage(id);
      setImages((prev) => prev.filter((i) => i.id !== id));
      toast.success('Image deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const openDeployModal = (image: ManagedImage) => {
    setDeployingImage(image);
    setDeployTag(image.latestTag || image.currentTag);
    setDeployAutoRollback(true);
  };

  const handleDeploy = async () => {
    if (!deployingImage || !deployTag) return;

    setDeploying(true);
    try {
      const { plan } = await deployManagedImage(deployingImage.id, deployTag, deployAutoRollback);
      toast.success(`Deployment plan created: ${plan.name}`);
      setDeployingImage(null);
      // Refresh images to get updated currentTag
      if (selectedEnvironment?.id) {
        const { images: updated } = await listManagedImages(selectedEnvironment.id);
        setImages(updated);
      }
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
      const { history } = await getManagedImageHistory(imageId);
      setHistory(history);
    } catch (error) {
      toast.error('Failed to load history');
    } finally {
      setLoadingHistory(false);
    }
  };

  const openLinkModal = async (image: ManagedImage) => {
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
      await linkServiceToManagedImage(linkingImage.id, serviceId);
      toast.success('Service linked');
      // Refresh
      if (selectedEnvironment?.id) {
        const { images: updated } = await listManagedImages(selectedEnvironment.id);
        setImages(updated);
        const { services } = await getLinkableServices(linkingImage.id);
        setLinkableServices(services);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to link');
    }
  };

  const handleUnlinkService = async (imageId: string, serviceId: string) => {
    try {
      await unlinkServiceFromManagedImage(imageId, serviceId);
      toast.success('Service unlinked');
      if (selectedEnvironment?.id) {
        const { images: updated } = await listManagedImages(selectedEnvironment.id);
        setImages(updated);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to unlink');
    }
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-8">
        <div className="card text-center py-12">
          <p className="text-slate-400">Select an environment to view managed images</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Managed Images</h1>
          <p className="text-slate-400 mt-1">
            Central image management for orchestrated deployments
          </p>
        </div>
        <button onClick={openCreate} className="btn btn-primary">
          Add Managed Image
        </button>
      </div>

      {loading ? (
        <div className="card">
          <div className="animate-pulse space-y-4">
            <div className="h-12 bg-slate-700 rounded"></div>
            <div className="h-12 bg-slate-700 rounded"></div>
          </div>
        </div>
      ) : images.length === 0 ? (
        <div className="card text-center py-12">
          <ImageIcon className="w-12 h-12 text-slate-500 mx-auto mb-4" />
          <p className="text-slate-400 mb-4">No managed images configured</p>
          <p className="text-slate-500 text-sm mb-4">
            Create managed images to deploy the same image to multiple services with orchestration
          </p>
          <button onClick={openCreate} className="btn btn-primary">
            Add Your First Managed Image
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {images.map((image) => (
            <div key={image.id} className="card">
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
                      {image.latestTag && image.latestTag !== image.currentTag && (
                        <span className="badge bg-yellow-500/20 text-yellow-400 text-xs">
                          {image.latestTag} available
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
                      <span>
                        Updated {formatDistanceToNow(new Date(image.updatedAt), { addSuffix: true })}
                      </span>
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
                            <button
                              onClick={() => handleUnlinkService(image.id, service.id)}
                              className="text-slate-500 hover:text-red-400 ml-1"
                              title="Unlink service"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
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
                    className="btn btn-ghost text-sm"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(image.id)}
                    className="btn btn-ghost text-sm text-red-400 hover:text-red-300"
                  >
                    Delete
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
                          className="flex items-center justify-between p-2 bg-slate-800/50 rounded text-sm"
                        >
                          <div className="flex items-center gap-4">
                            <span className="font-mono text-white">{entry.tag}</span>
                            <span className="text-slate-500">
                              {formatDistanceToNow(new Date(entry.deployedAt), { addSuffix: true })}
                            </span>
                          </div>
                          <span className="text-slate-400">{entry.deployedBy}</span>
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

      {/* Create/Edit Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingId ? 'Edit Managed Image' : 'Add Managed Image'}
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
              Services using image <code className="text-primary-400">{linkingImage.imageName}</code>
            </p>

            {loadingLinkable ? (
              <div className="animate-pulse space-y-2">
                <div className="h-10 bg-slate-700 rounded"></div>
              </div>
            ) : linkableServices.length === 0 ? (
              <p className="text-slate-500 text-sm">
                No unlinked services found with matching image name.
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

import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import {
  getContainerImage,
  listContainerImageDigests,
  checkContainerImageUpdates,
  deployContainerImage,
  getContainerImageHistory,
  getContainerImageTags,
  updateContainerImageSettings,
  type ContainerImage,
  type ImageDigest,
  type ContainerImageHistory,
  type RegistryTag,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';
import { RefreshIcon } from '../components/Icons';
import { Modal } from '../components/Modal';
import Pagination from '../components/Pagination';

function formatDigestShort(digest: string): string {
  const stripped = digest.startsWith('sha256:') ? digest.slice(7) : digest;
  return stripped.slice(0, 12);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function getStatusBadge(status: string) {
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
}

type TabKey = 'services' | 'history' | 'registry';

export default function ContainerImageDetail() {
  const { id } = useParams<{ id: string }>();
  const { setBreadcrumbName } = useAppStore();
  const toast = useToast();

  // Core state
  const [image, setImage] = useState<ContainerImage | null>(null);
  const [loading, setLoading] = useState(true);

  // Digests table
  const [digests, setDigests] = useState<ImageDigest[]>([]);
  const [digestsTotal, setDigestsTotal] = useState(0);
  const [digestPage, setDigestPage] = useState(0);
  const [digestPageSize, setDigestPageSize] = useState(10);
  const [loadingDigests, setLoadingDigests] = useState(false);

  // Actions
  const [checking, setChecking] = useState(false);
  const [togglingAutoUpdate, setTogglingAutoUpdate] = useState(false);

  // Tabs
  const [activeTab, setActiveTab] = useState<TabKey>('services');
  const [history, setHistory] = useState<ContainerImageHistory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [registryTags, setRegistryTags] = useState<RegistryTag[]>([]);
  const [registryTagFilter, setRegistryTagFilter] = useState('');
  const [loadingTags, setLoadingTags] = useState(false);

  // Deploy modal
  const [deployDigest, setDeployDigest] = useState<ImageDigest | null>(null);
  const [deployAutoRollback, setDeployAutoRollback] = useState(true);
  const [deploying, setDeploying] = useState(false);

  // Load image
  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getContainerImage(id)
      .then(({ image }) => {
        setImage(image);
        setBreadcrumbName(id, image.name);
      })
      .catch(() => toast.error('Failed to load container image'))
      .finally(() => setLoading(false));
  }, [id]);

  // Load digests
  useEffect(() => {
    if (!id) return;
    setLoadingDigests(true);
    listContainerImageDigests(id, {
      limit: digestPageSize,
      offset: digestPage * digestPageSize,
    })
      .then(({ digests, total }) => {
        setDigests(digests);
        setDigestsTotal(total);
      })
      .catch(() => toast.error('Failed to load digests'))
      .finally(() => setLoadingDigests(false));
  }, [id, digestPage, digestPageSize]);

  // Load tab data
  useEffect(() => {
    if (!id) return;
    if (activeTab === 'history' && history.length === 0) {
      setLoadingHistory(true);
      getContainerImageHistory(id, 50)
        .then(({ history }) => setHistory(history))
        .catch(() => toast.error('Failed to load history'))
        .finally(() => setLoadingHistory(false));
    }
    if (activeTab === 'registry' && registryTags.length === 0) {
      setLoadingTags(true);
      getContainerImageTags(id)
        .then(({ tags, tagFilter }) => {
          setRegistryTags(tags);
          setRegistryTagFilter(tagFilter);
        })
        .catch(() => toast.error('Failed to load registry tags'))
        .finally(() => setLoadingTags(false));
    }
  }, [id, activeTab]);

  const reloadImage = async () => {
    if (!id) return;
    const { image } = await getContainerImage(id);
    setImage(image);
  };

  const handleCheckUpdates = async () => {
    if (!id) return;
    setChecking(true);
    try {
      const result = await checkContainerImageUpdates(id);
      await reloadImage();
      // Refresh digests after check
      const digestResult = await listContainerImageDigests(id, {
        limit: digestPageSize,
        offset: digestPage * digestPageSize,
      });
      setDigests(digestResult.digests);
      setDigestsTotal(digestResult.total);

      if (result.hasUpdate) {
        toast.success(`Update available: ${result.newestDigest?.bestTag || 'new digest'} (${result.newDigests} new)`);
      } else {
        toast.success('No updates available');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to check updates');
    } finally {
      setChecking(false);
    }
  };

  const handleToggleAutoUpdate = async () => {
    if (!id || !image) return;
    setTogglingAutoUpdate(true);
    try {
      await updateContainerImageSettings(id, { autoUpdate: !image.autoUpdate });
      await reloadImage();
      toast.success(image.autoUpdate ? 'Auto-update disabled' : 'Auto-update enabled');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update setting');
    } finally {
      setTogglingAutoUpdate(false);
    }
  };

  const handleDeploy = async () => {
    if (!id || !deployDigest) return;
    setDeploying(true);
    try {
      const { plan } = await deployContainerImage(id, {
        imageTag: deployDigest.bestTag || undefined,
        imageDigestId: deployDigest.id,
        autoRollback: deployAutoRollback,
      });
      toast.success(`Deployment plan created: ${plan.name}`);
      setDeployDigest(null);
      await reloadImage();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Deployment failed');
    } finally {
      setDeploying(false);
    }
  };

  const openDeployModal = (digest: ImageDigest) => {
    setDeployDigest(digest);
    setDeployAutoRollback(true);
  };

  // Determine currently deployed digest IDs from services
  const deployedDigestIds = new Set(
    image?.services
      ?.map((s: any) => s.imageDigestId)
      .filter(Boolean) ?? []
  );
  // Use deployedDigest (actual deployed SHA) for status bar, fall back to latestDigest
  const currentDigest = image?.deployedDigest || image?.latestDigest;

  const digestTotalPages = Math.ceil(digestsTotal / digestPageSize);

  if (loading) {
    return (
      <div className="p-6">
        <div className="panel">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-slate-700 rounded w-1/3"></div>
            <div className="h-4 bg-slate-700 rounded w-1/2"></div>
            <div className="h-32 bg-slate-700 rounded"></div>
          </div>
        </div>
      </div>
    );
  }

  if (!image) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-slate-400">Container image not found</p>
          <Link to="/container-images" className="text-primary-400 hover:text-primary-300 text-sm mt-2 inline-block">
            Back to Container Images
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="panel">
        <div className="flex items-start justify-between">
          <div>
            <Link to="/container-images" className="text-sm text-slate-400 hover:text-primary-400 mb-2 inline-block">
              &larr; Container Images
            </Link>
            <h2 className="text-2xl font-bold text-white">{image.name}</h2>
            <p className="text-slate-400 font-mono text-sm mt-1">{image.imageName}</p>
            <div className="flex items-center gap-2 mt-2">
              <span className="badge bg-slate-700 text-slate-300 text-xs font-mono">
                {image.tagFilter}
              </span>
              {image.updateAvailable && (
                <span className="badge bg-yellow-500/20 text-yellow-400 text-xs">
                  Update Available
                </span>
              )}
              {image.autoUpdate && (
                <span className="badge bg-green-500/20 text-green-400 text-xs">
                  Auto-update
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Auto-update toggle */}
            {image.registryConnectionId && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-400">Auto-update</span>
                <button
                  type="button"
                  onClick={handleToggleAutoUpdate}
                  disabled={togglingAutoUpdate}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    image.autoUpdate ? 'bg-primary-600' : 'bg-slate-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      image.autoUpdate ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            )}
            <button
              onClick={handleCheckUpdates}
              disabled={checking}
              className="btn btn-primary"
            >
              <RefreshIcon className={`w-4 h-4 mr-2 inline ${checking ? 'animate-spin' : ''}`} />
              {checking ? 'Checking...' : 'Check Updates'}
            </button>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="panel">
        <div className="flex items-center gap-6 text-sm">
          {/* Current SHA */}
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Deployed SHA: </span>
            {currentDigest ? (
              <>
                <span className="font-mono text-white">
                  {formatDigestShort(currentDigest.manifestDigest)}
                </span>
                {currentDigest.tags && currentDigest.tags.length > 0 && (
                  <div className="flex items-center gap-1">
                    {currentDigest.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="badge bg-slate-700 text-slate-300 text-xs">
                        {tag}
                      </span>
                    ))}
                    {currentDigest.tags.length > 3 && (
                      <span className="text-slate-500 text-xs">+{currentDigest.tags.length - 3}</span>
                    )}
                  </div>
                )}
              </>
            ) : (
              <span className="text-slate-500">None</span>
            )}
          </div>

          {/* Update indicator */}
          {image.updateAvailable && (
            <span className="text-yellow-400 font-medium">Update Available</span>
          )}

          {/* Service count */}
          <div>
            <span className="text-slate-500">Services: </span>
            <span className="text-white">{image.services.length} linked</span>
          </div>

          {/* Last checked */}
          <div>
            <span className="text-slate-500">Last checked: </span>
            <span className="text-slate-300">
              {image.lastCheckedAt
                ? formatDistanceToNow(new Date(image.lastCheckedAt), { addSuffix: true })
                : 'Never'}
            </span>
          </div>
        </div>
      </div>

      {/* Digests table */}
      <div className="panel">
        <h3 className="text-lg font-semibold text-white mb-4">Image Digests</h3>
        {loadingDigests ? (
          <div className="animate-pulse space-y-3">
            <div className="h-10 bg-slate-700 rounded"></div>
            <div className="h-10 bg-slate-700 rounded"></div>
            <div className="h-10 bg-slate-700 rounded"></div>
          </div>
        ) : digests.length === 0 ? (
          <p className="text-slate-500 text-sm">No digests found. Try checking for updates.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-slate-400 text-xs border-b border-slate-700">
                    <th className="pb-2 font-medium">SHA</th>
                    <th className="pb-2 font-medium">Best Tag</th>
                    <th className="pb-2 font-medium">Tags</th>
                    <th className="pb-2 font-medium">Size</th>
                    <th className="pb-2 font-medium">Updated</th>
                    <th className="pb-2 font-medium">Discovered</th>
                    <th className="pb-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {digests.map((digest) => {
                    const isDeployed = deployedDigestIds.has(digest.id) ||
                      (currentDigest && currentDigest.manifestDigest === digest.manifestDigest);
                    return (
                      <tr
                        key={digest.id}
                        className={`text-sm ${isDeployed ? 'bg-primary-500/5' : ''}`}
                      >
                        <td className="py-2.5">
                          <span className="font-mono text-white">
                            {formatDigestShort(digest.manifestDigest)}
                          </span>
                          {isDeployed && (
                            <span className="ml-2 badge bg-primary-500/20 text-primary-400 text-xs">
                              deployed
                            </span>
                          )}
                        </td>
                        <td className="py-2.5">
                          {digest.bestTag ? (
                            <span className="font-mono text-slate-300">{digest.bestTag}</span>
                          ) : (
                            <span className="text-slate-600">-</span>
                          )}
                        </td>
                        <td className="py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {digest.tags.length > 0 ? (
                              digest.tags.slice(0, 5).map((tag) => (
                                <span
                                  key={tag}
                                  className="badge bg-slate-700 text-slate-300 text-xs"
                                >
                                  {tag}
                                </span>
                              ))
                            ) : (
                              <span className="text-slate-600 text-xs">untagged</span>
                            )}
                            {digest.tags.length > 5 && (
                              <span className="text-slate-500 text-xs">
                                +{digest.tags.length - 5}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 text-slate-400">
                          {digest.size ? formatBytes(digest.size) : '-'}
                        </td>
                        <td className="py-2.5 text-slate-400">
                          {digest.pushedAt
                            ? formatDistanceToNow(new Date(digest.pushedAt), { addSuffix: true })
                            : '-'}
                        </td>
                        <td className="py-2.5 text-slate-400">
                          {formatDistanceToNow(new Date(digest.discoveredAt), { addSuffix: true })}
                        </td>
                        <td className="py-2.5 text-right">
                          {image.services.length > 0 && !isDeployed && (
                            <button
                              onClick={() => openDeployModal(digest)}
                              className="btn btn-primary text-xs px-2 py-1"
                            >
                              Deploy
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              currentPage={digestPage}
              totalPages={digestTotalPages}
              totalItems={digestsTotal}
              pageSize={digestPageSize}
              onPageChange={setDigestPage}
              onPageSizeChange={(size) => {
                setDigestPageSize(size);
                setDigestPage(0);
              }}
            />
          </>
        )}
      </div>

      {/* Tabs */}
      <div className="panel">
        <div className="flex border-b border-slate-700 mb-4">
          {[
            { key: 'services' as TabKey, label: `Linked Services (${image.services.length})` },
            { key: 'history' as TabKey, label: 'Deployment History' },
            { key: 'registry' as TabKey, label: 'Browse Registry' },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-primary-400 text-primary-400'
                  : 'border-transparent text-slate-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Linked Services tab */}
        {activeTab === 'services' && (
          <div>
            {image.services.length === 0 ? (
              <p className="text-slate-500 text-sm">No services linked to this image.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-slate-400 text-xs border-b border-slate-700">
                      <th className="pb-2 font-medium">Service</th>
                      <th className="pb-2 font-medium">Server</th>
                      <th className="pb-2 font-medium">Image Tag</th>
                      <th className="pb-2 font-medium">Deployed SHA</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/50">
                    {image.services.map((service: any) => (
                      <tr key={service.id} className="text-sm">
                        <td className="py-2.5">
                          <Link
                            to={`/services/${service.id}`}
                            className="text-white hover:text-primary-400"
                          >
                            {service.name}
                          </Link>
                        </td>
                        <td className="py-2.5 text-slate-400">
                          {service.server?.name || '-'}
                        </td>
                        <td className="py-2.5">
                          <span className="font-mono text-slate-300">{service.imageTag}</span>
                        </td>
                        <td className="py-2.5">
                          {service.imageDigest ? (
                            <span className="font-mono text-slate-400 text-xs">
                              {formatDigestShort(service.imageDigest.manifestDigest)}
                            </span>
                          ) : (
                            <span className="text-slate-600 text-xs">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Deployment History tab */}
        {activeTab === 'history' && (
          <div>
            {loadingHistory ? (
              <div className="animate-pulse space-y-2">
                <div className="h-10 bg-slate-700 rounded"></div>
                <div className="h-10 bg-slate-700 rounded"></div>
              </div>
            ) : history.length === 0 ? (
              <p className="text-slate-500 text-sm">No deployment history.</p>
            ) : (
              <div className="space-y-2">
                {history.map((entry) => {
                  const sha = entry.imageDigest?.manifestDigest || entry.digest;
                  const historyTags = entry.imageDigest?.tags || [];
                  return (
                    <div key={entry.id} className="p-3 bg-slate-800/50 rounded text-sm">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {sha ? (
                            <span className="font-mono text-white">
                              {formatDigestShort(sha)}
                            </span>
                          ) : (
                            <span className="font-mono text-white">{entry.tag}</span>
                          )}
                          <span className={`badge text-xs ${getStatusBadge(entry.status)}`}>
                            {entry.status}
                          </span>
                          {historyTags.length > 0 ? (
                            <div className="flex items-center gap-1">
                              {historyTags.slice(0, 3).map((tag) => (
                                <span key={tag} className="badge bg-slate-700 text-slate-300 text-xs">
                                  {tag}
                                </span>
                              ))}
                              {historyTags.length > 3 && (
                                <span className="text-slate-500 text-xs">+{historyTags.length - 3}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-slate-500 text-xs">{entry.tag}</span>
                          )}
                          {entry.deploymentCount && entry.deploymentCount > 0 && (
                            <span className="text-slate-500">
                              {entry.deploymentCount} deployment{entry.deploymentCount !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-slate-400">
                          {entry.deployedBy && <span>{entry.deployedBy}</span>}
                          <span className="text-slate-500">
                            {format(new Date(entry.deployedAt), 'MMM d, HH:mm')}
                          </span>
                        </div>
                      </div>
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
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Browse Registry tab */}
        {activeTab === 'registry' && (
          <div>
            {loadingTags ? (
              <div className="animate-pulse space-y-2">
                <div className="h-10 bg-slate-700 rounded"></div>
                <div className="h-10 bg-slate-700 rounded"></div>
              </div>
            ) : registryTags.length === 0 ? (
              <p className="text-slate-500 text-sm">
                {image.registryConnectionId
                  ? 'No tags found in registry.'
                  : 'No registry connection configured for this image.'}
              </p>
            ) : (
              <>
                {registryTagFilter && (
                  <p className="text-xs text-slate-500 mb-3">
                    Showing tags matching filter: <span className="font-mono text-slate-400">{registryTagFilter}</span>
                  </p>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-slate-400 text-xs border-b border-slate-700">
                        <th className="pb-2 font-medium">Tag</th>
                        <th className="pb-2 font-medium">Digest</th>
                        <th className="pb-2 font-medium">Size</th>
                        <th className="pb-2 font-medium">Updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/50">
                      {registryTags.map((tag) => (
                        <tr key={tag.digest + tag.tag} className="text-sm">
                          <td className="py-2">
                            <span className="font-mono text-white">{tag.tag}</span>
                          </td>
                          <td className="py-2">
                            {tag.digest ? (
                              <span className="font-mono text-slate-400 text-xs">
                                {tag.digest.substring(0, 19)}
                              </span>
                            ) : (
                              <span className="text-slate-600 text-xs italic">unavailable</span>
                            )}
                          </td>
                          <td className="py-2 text-slate-400">
                            {tag.size ? formatBytes(tag.size) : '-'}
                          </td>
                          <td className="py-2 text-slate-400">
                            {tag.updatedAt
                              ? formatDistanceToNow(new Date(tag.updatedAt), { addSuffix: true })
                              : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Deploy Modal */}
      <Modal
        isOpen={!!deployDigest}
        onClose={() => setDeployDigest(null)}
        title="Deploy Image"
        subtitle={deployDigest ? `${formatDigestShort(deployDigest.manifestDigest)}${deployDigest.bestTag ? ` (${deployDigest.bestTag})` : ''}` : undefined}
        size="lg"
        footer={
          <>
            <button onClick={() => setDeployDigest(null)} className="btn btn-ghost">
              Cancel
            </button>
            <button
              onClick={handleDeploy}
              disabled={deploying}
              className="btn btn-primary"
            >
              {deploying ? 'Starting Deploy...' : 'Deploy'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="bg-slate-800/50 rounded p-3">
            <div className="text-sm text-slate-400 mb-1">Digest</div>
            <div className="font-mono text-white text-sm">
              {deployDigest && formatDigestShort(deployDigest.manifestDigest)}
              {deployDigest?.bestTag && (
                <span className="text-slate-400 ml-2">({deployDigest.bestTag})</span>
              )}
            </div>
          </div>

          <div>
            <div className="text-sm text-slate-400 mb-2">
              Services to update ({image.services.length}):
            </div>
            <div className="space-y-1">
              {image.services.map((s: any) => (
                <div key={s.id} className="flex items-center gap-2 p-2 bg-slate-800/50 rounded text-sm">
                  <span className="text-white">{s.name}</span>
                  {s.server?.name && (
                    <span className="text-slate-500">on {s.server.name}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="deployAutoRollback"
              checked={deployAutoRollback}
              onChange={(e) => setDeployAutoRollback(e.target.checked)}
              className="rounded bg-slate-700 border-slate-600 text-primary-500 focus:ring-primary-500"
            />
            <label htmlFor="deployAutoRollback" className="text-sm text-slate-300">
              Auto-rollback on failure
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}

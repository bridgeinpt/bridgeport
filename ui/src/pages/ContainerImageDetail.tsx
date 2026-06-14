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
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { formatDigestShort } from '@/lib/image-utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/ui/copy-button';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { DataPagination } from '@/components/ui/data-pagination';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
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
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (!image) {
    return (
      <div className="p-6">
        <div className="rounded-lg border bg-card p-4 text-center py-12">
          <p className="text-muted-foreground">Container image not found</p>
          <Link to="/container-images" className="text-primary hover:underline text-sm mt-2 inline-block">
            Back to Container Images
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start justify-between">
          <div>
            <Link to="/container-images" className="text-sm text-muted-foreground hover:text-primary mb-2 inline-flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" /> Container Images
            </Link>
            <h2 className="text-2xl font-bold text-foreground">{image.name}</h2>
            <p className="text-muted-foreground font-mono text-sm mt-1">{image.imageName}</p>
            <div className="flex items-center gap-2 mt-2">
              <Badge variant="secondary" className="font-mono">{image.tagFilter}</Badge>
              {image.updateAvailable && (
                <Badge variant="warning">Update Available</Badge>
              )}
              {image.autoUpdate && (
                <Badge variant="success">Auto-update</Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Auto-update toggle */}
            {image.registryConnectionId && (
              <div className="flex items-center gap-2">
                <Label htmlFor="auto-update-toggle" className="text-muted-foreground">Auto-update</Label>
                <Switch
                  id="auto-update-toggle"
                  checked={image.autoUpdate}
                  onCheckedChange={handleToggleAutoUpdate}
                  disabled={togglingAutoUpdate}
                />
              </div>
            )}
            <Button onClick={handleCheckUpdates} disabled={checking}>
              <RefreshCw className={`w-4 h-4 mr-2 ${checking ? 'animate-spin' : ''}`} />
              {checking ? 'Checking...' : 'Check Updates'}
            </Button>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-6 text-sm">
          {/* Current SHA */}
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Deployed SHA: </span>
            {currentDigest ? (
              <>
                <span className="font-mono text-foreground">
                  {formatDigestShort(currentDigest.manifestDigest)}
                </span>
                <CopyButton value={currentDigest.manifestDigest} size="icon-xs" />
                {currentDigest.tags && currentDigest.tags.length > 0 && (
                  <div className="flex items-center gap-1">
                    {currentDigest.tags.slice(0, 3).map((tag) => (
                      <Badge key={tag} variant="secondary">{tag}</Badge>
                    ))}
                    {currentDigest.tags.length > 3 && (
                      <span className="text-muted-foreground text-xs">+{currentDigest.tags.length - 3}</span>
                    )}
                  </div>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </div>

          {/* Update indicator */}
          {image.updateAvailable && (
            <span className="text-warning font-medium">Update Available</span>
          )}

          {/* Service count */}
          <div>
            <span className="text-muted-foreground">Services: </span>
            <span className="text-foreground">{image.services.length} linked</span>
          </div>

          {/* Last checked */}
          <div>
            <span className="text-muted-foreground">Last checked: </span>
            <span className="text-foreground">
              {image.lastCheckedAt
                ? formatDistanceToNow(new Date(image.lastCheckedAt), { addSuffix: true })
                : 'Never'}
            </span>
          </div>
        </div>
      </div>

      {/* Digests table */}
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-lg font-semibold text-foreground mb-4">Image Digests</h3>
        {loadingDigests ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : digests.length === 0 ? (
          <p className="text-muted-foreground text-sm">No digests found. Try checking for updates.</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SHA</TableHead>
                  <TableHead>Best Tag</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>Discovered</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {digests.map((digest) => {
                  const isDeployed = deployedDigestIds.has(digest.id) ||
                    (currentDigest && currentDigest.manifestDigest === digest.manifestDigest);
                  return (
                    <TableRow
                      key={digest.id}
                      className={isDeployed ? 'bg-primary/5' : ''}
                    >
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-foreground">
                            {formatDigestShort(digest.manifestDigest)}
                          </span>
                          <CopyButton value={digest.manifestDigest} size="icon-xs" />
                          {isDeployed && (
                            <Badge variant="info">deployed</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {digest.bestTag ? (
                          <span className="font-mono text-foreground">{digest.bestTag}</span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {digest.tags.length > 0 ? (
                            digest.tags.slice(0, 5).map((tag) => (
                              <Badge key={tag} variant="secondary">{tag}</Badge>
                            ))
                          ) : (
                            <span className="text-muted-foreground text-xs">untagged</span>
                          )}
                          {digest.tags.length > 5 && (
                            <span className="text-muted-foreground text-xs">
                              +{digest.tags.length - 5}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {digest.size ? formatBytes(digest.size) : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {digest.pushedAt
                          ? formatDistanceToNow(new Date(digest.pushedAt), { addSuffix: true })
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDistanceToNow(new Date(digest.discoveredAt), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="text-right">
                        {image.services.length > 0 && !isDeployed && (
                          <Button size="xs" onClick={() => openDeployModal(digest)}>
                            Deploy
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <DataPagination
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
      <div className="rounded-lg border bg-card p-4">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)}>
          <TabsList variant="line" className="mb-4">
            <TabsTrigger value="services">Linked Services ({image.services.length})</TabsTrigger>
            <TabsTrigger value="history">Deployment History</TabsTrigger>
            <TabsTrigger value="registry">Browse Registry</TabsTrigger>
          </TabsList>

          {/* Linked Services tab */}
          <TabsContent value="services">
            {image.services.length === 0 ? (
              <p className="text-muted-foreground text-sm">No services linked to this image.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Service</TableHead>
                    <TableHead>Server</TableHead>
                    <TableHead>Image Tag</TableHead>
                    <TableHead>Deployed SHA</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {image.services.map((service: any) => (
                    <TableRow key={service.id}>
                      <TableCell>
                        <Link
                          to={`/services/${service.id}`}
                          className="text-foreground hover:text-primary"
                        >
                          {service.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {service.server?.name || '-'}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-foreground">{service.imageTag}</span>
                      </TableCell>
                      <TableCell>
                        {service.imageDigest ? (
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-muted-foreground text-xs">
                              {formatDigestShort(service.imageDigest.manifestDigest)}
                            </span>
                            <CopyButton value={service.imageDigest.manifestDigest} size="icon-xs" />
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          {/* Deployment History tab */}
          <TabsContent value="history">
            {loadingHistory ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : history.length === 0 ? (
              <p className="text-muted-foreground text-sm">No deployment history.</p>
            ) : (
              <div className="space-y-2">
                {history.map((entry) => {
                  const sha = entry.imageDigest?.manifestDigest || entry.digest;
                  const historyTags = entry.imageDigest?.tags || [];
                  return (
                    <div key={entry.id} className="p-3 bg-muted/50 rounded text-sm">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {sha ? (
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-foreground">
                                {formatDigestShort(sha)}
                              </span>
                              <CopyButton value={sha} size="icon-xs" />
                            </div>
                          ) : (
                            <span className="font-mono text-foreground">{entry.tag}</span>
                          )}
                          <StatusBadge
                            kind="deployment"
                            value={entry.status}
                            label={entry.status}
                          />
                          {historyTags.length > 0 ? (
                            <div className="flex items-center gap-1">
                              {historyTags.slice(0, 3).map((tag) => (
                                <Badge key={tag} variant="secondary">{tag}</Badge>
                              ))}
                              {historyTags.length > 3 && (
                                <span className="text-muted-foreground text-xs">+{historyTags.length - 3}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs">{entry.tag}</span>
                          )}
                          {entry.deploymentCount && entry.deploymentCount > 0 && (
                            <span className="text-muted-foreground">
                              {entry.deploymentCount} deployment{entry.deploymentCount !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-muted-foreground">
                          {entry.deployedBy && <span>{entry.deployedBy}</span>}
                          <span>
                            {format(new Date(entry.deployedAt), 'MMM d, HH:mm')}
                          </span>
                        </div>
                      </div>
                      {entry.services && entry.services.length > 0 && (
                        <div className="mt-2 pt-2 border-t flex flex-wrap gap-2">
                          {entry.services.map((svc) => (
                            <div
                              key={svc.id}
                              className="flex items-center gap-1 px-2 py-0.5 bg-muted rounded text-xs"
                            >
                              <span className="text-foreground">{svc.name}</span>
                              <span className="text-muted-foreground">on {svc.serverName}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* Browse Registry tab */}
          <TabsContent value="registry">
            {loadingTags ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : registryTags.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {image.registryConnectionId
                  ? 'No tags found in registry.'
                  : 'No registry connection configured for this image.'}
              </p>
            ) : (
              <>
                {registryTagFilter && (
                  <p className="text-xs text-muted-foreground mb-3">
                    Showing tags matching filter: <span className="font-mono text-foreground">{registryTagFilter}</span>
                  </p>
                )}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tag</TableHead>
                      <TableHead>Digest</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {registryTags.map((tag) => (
                      <TableRow key={tag.digest + tag.tag}>
                        <TableCell>
                          <span className="font-mono text-foreground">{tag.tag}</span>
                        </TableCell>
                        <TableCell>
                          {tag.digest ? (
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-muted-foreground text-xs">
                                {tag.digest.substring(0, 19)}
                              </span>
                              <CopyButton value={tag.digest} size="icon-xs" />
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs italic">unavailable</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {tag.size ? formatBytes(tag.size) : '-'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {tag.updatedAt
                            ? formatDistanceToNow(new Date(tag.updatedAt), { addSuffix: true })
                            : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Deploy Modal */}
      <Dialog
        open={!!deployDigest}
        onOpenChange={(open) => {
          if (!open) setDeployDigest(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deploy Image</DialogTitle>
            {deployDigest && (
              <DialogDescription>
                {formatDigestShort(deployDigest.manifestDigest)}
                {deployDigest.bestTag ? ` (${deployDigest.bestTag})` : ''}
              </DialogDescription>
            )}
          </DialogHeader>

          <div className="space-y-4">
            <div className="bg-muted/50 rounded p-3">
              <div className="text-sm text-muted-foreground mb-1">Digest</div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-foreground text-sm">
                  {deployDigest && formatDigestShort(deployDigest.manifestDigest)}
                  {deployDigest?.bestTag && (
                    <span className="text-muted-foreground ml-2">({deployDigest.bestTag})</span>
                  )}
                </span>
                {deployDigest && (
                  <CopyButton value={deployDigest.manifestDigest} size="icon-xs" />
                )}
              </div>
            </div>

            <div>
              <div className="text-sm text-muted-foreground mb-2">
                Services to update ({image.services.length}):
              </div>
              <div className="space-y-1">
                {image.services.map((s: any) => (
                  <div key={s.id} className="flex items-center gap-2 p-2 bg-muted/50 rounded text-sm">
                    <span className="text-foreground">{s.name}</span>
                    {s.server?.name && (
                      <span className="text-muted-foreground">on {s.server.name}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="deployAutoRollback"
                checked={deployAutoRollback}
                onCheckedChange={(checked) => setDeployAutoRollback(checked === true)}
              />
              <Label htmlFor="deployAutoRollback" className="text-muted-foreground">
                Auto-rollback on failure
              </Label>
            </div>
          </div>

          <DialogFooter className="pt-4">
            <Button type="button" variant="ghost" onClick={() => setDeployDigest(null)}>
              Cancel
            </Button>
            <Button onClick={handleDeploy} disabled={deploying}>
              {deploying ? 'Starting Deploy...' : 'Deploy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

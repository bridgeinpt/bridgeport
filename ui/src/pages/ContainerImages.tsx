import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import { usePaginatedFetch } from '../hooks/usePaginatedFetch.js';
import {
  listContainerImages,
  createContainerImage,
  updateContainerImage,
  updateContainerImageSettings,
  deleteContainerImage,
  deployContainerImage,
  linkServiceToContainerImage,
  getLinkableServices,
  listRegistryConnections,
  checkContainerImageUpdates,
  type ContainerImage,
  type ContainerImageInput,
  type Service,
  type RegistryConnection,
} from '../lib/api';
import { formatDistanceToNow } from 'date-fns';
import { Pencil, Trash2, RefreshCw, Link as LinkIcon, Image as ImageIcon } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { formatDigestShort } from '@/lib/image-utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { DataPagination } from '@/components/ui/data-pagination';

const REGISTRY_NONE = '__none__';

export default function ContainerImages() {
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const confirm = useConfirm();
  const { items: images, total, loading, currentPage, pageSize, totalPages, setCurrentPage, setPageSize, reload } =
    usePaginatedFetch<ContainerImage>({
      fetcher: ({ limit, offset }) =>
        listContainerImages(selectedEnvironment!.id, { limit, offset }).then(r => ({
          items: r.images,
          total: r.total,
        })),
      deps: [selectedEnvironment?.id],
      enabled: !!selectedEnvironment?.id,
    });

  const [registries, setRegistries] = useState<RegistryConnection[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Deploy modal
  const [deployingImage, setDeployingImage] = useState<ContainerImage | null>(null);
  const [deployAutoRollback, setDeployAutoRollback] = useState(true);
  const [deploying, setDeploying] = useState(false);

  // Link services
  const [linkingImage, setLinkingImage] = useState<ContainerImage | null>(null);
  const [linkableServices, setLinkableServices] = useState<Service[]>([]);
  const [loadingLinkable, setLoadingLinkable] = useState(false);

  // Check updates state
  const [checkingUpdatesId, setCheckingUpdatesId] = useState<string | null>(null);

  // Edit form auto-update state
  const [editAutoUpdate, setEditAutoUpdate] = useState(false);

  // Form state
  const [formData, setFormData] = useState<ContainerImageInput>({
    name: '',
    imageName: '',
    tagFilter: 'latest',
    registryConnectionId: null,
  });

  useEffect(() => {
    if (selectedEnvironment?.id) {
      listRegistryConnections(selectedEnvironment.id).then(r => setRegistries(r.registries));
    }
  }, [selectedEnvironment?.id]);

  const resetForm = () => {
    setFormData({
      name: '',
      imageName: '',
      tagFilter: 'latest',
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
      tagFilter: image.tagFilter,
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
      reload();
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
    const ok = await confirm({
      title: `Delete container image "${image.name}"?`,
      description: 'Services linked to this image cannot be deleted.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;

    try {
      await deleteContainerImage(id);
      toast.success('Image deleted');
      reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const openDeployModal = (image: ContainerImage) => {
    setDeployingImage(image);
    setDeployAutoRollback(true);
  };

  const handleDeploy = async () => {
    if (!deployingImage) return;
    const digest = deployingImage.latestDigest;
    if (!digest) return;

    setDeploying(true);
    try {
      const { plan } = await deployContainerImage(deployingImage.id, {
        imageTag: digest.bestTag || undefined,
        imageDigestId: digest.id,
        autoRollback: deployAutoRollback,
      });
      toast.success(`Deployment plan created: ${plan.name}`);
      setDeployingImage(null);
      reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Deployment failed');
    } finally {
      setDeploying(false);
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
      reload();
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
      reload();
      if (result.hasUpdate) {
        toast.success(`Update available: ${result.newestDigest?.bestTag || 'new digest'}`);
      } else {
        toast.success('No updates available');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to check updates');
    } finally {
      setCheckingUpdatesId(null);
    }
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <div className="rounded-lg border bg-card p-4 text-center py-12">
          <p className="text-muted-foreground">Select an environment to view container images</p>
        </div>
      </div>
    );
  }

  const deployDigestShort = deployingImage?.latestDigest
    ? formatDigestShort(deployingImage.latestDigest.manifestDigest)
    : '';

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-muted-foreground">
          Central image management for orchestrated deployments
        </p>
        <Button onClick={openCreate}>Add Container Image</Button>
      </div>

      {loading ? (
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : total === 0 ? (
        <EmptyState
          icon={ImageIcon}
          message="No container images configured"
          description="Create container images to deploy the same image to multiple services with orchestration"
          action={{ label: 'Add Your First Container Image', onClick: openCreate }}
        />
      ) : (
        <div className="space-y-4">
          {images.map((image) => (
            <div key={image.id} className="rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-muted rounded-lg">
                    <ImageIcon className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <Link to={`/container-images/${image.id}`} className="text-lg font-semibold text-foreground hover:text-primary">
                        {image.name}
                      </Link>
                      {image.latestDigest?.tags && image.latestDigest.tags.length > 0 ? (
                        <>
                          {image.latestDigest.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="secondary" className="font-mono">
                              {tag}
                            </Badge>
                          ))}
                          {image.latestDigest.tags.length > 3 && (
                            <span className="text-muted-foreground text-xs">+{image.latestDigest.tags.length - 3}</span>
                          )}
                        </>
                      ) : (
                        <Badge variant="secondary" className="font-mono">
                          {image.bestTag || image.tagFilter}
                        </Badge>
                      )}
                      {image.updateAvailable && (
                        <Badge variant="warning">update available</Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground text-sm mt-1 font-mono">{image.imageName}</p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      <span>
                        {image.services.length} service{image.services.length !== 1 ? 's' : ''} linked
                      </span>
                      {image.registryConnection && (
                        <span className="text-primary">
                          Registry: {image.registryConnection.name}
                        </span>
                      )}
                      {image.autoUpdate && (
                        <span className="text-success flex items-center gap-1">
                          <RefreshCw className="w-3 h-3" />
                          Auto-update enabled
                        </span>
                      )}
                      {image.lastDeployedAt ? (
                        <span>
                          Deployed {formatDistanceToNow(new Date(image.lastDeployedAt), { addSuffix: true })}
                        </span>
                      ) : (
                        <span>Never deployed</span>
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
                            className="flex items-center gap-1 px-2 py-1 bg-muted/50 rounded text-xs"
                          >
                            <Link
                              to={`/services/${service.id}`}
                              className="text-foreground hover:text-primary"
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
                  {image.services.length > 0 && image.latestDigest && (
                    <Button size="sm" onClick={() => openDeployModal(image)}>
                      {image.updateAvailable ? 'Deploy Update' : 'Deploy Latest'}
                    </Button>
                  )}
                  {image.registryConnectionId && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleCheckUpdates(image.id)}
                      disabled={checkingUpdatesId === image.id}
                      title="Check for updates"
                    >
                      <RefreshCw className={`w-4 h-4 ${checkingUpdatesId === image.id ? 'animate-spin' : ''}`} />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => openLinkModal(image)}
                    title="Link services"
                  >
                    <LinkIcon className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => openEdit(image)}
                    title="Edit"
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleDelete(image.id)}
                    title="Delete"
                    className="hover:text-destructive"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>

            </div>
          ))}
        </div>
      )}
      {total > 0 && (
        <DataPagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={total}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={setPageSize}
        />
      )}

      {/* Create/Edit Modal */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreate(false);
            resetForm();
            setEditingId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Container Image' : 'Add Container Image'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ci-name">Display Name</Label>
              <Input
                id="ci-name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="BIOS Backend"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ci-image-name">Image Name</Label>
              <Input
                id="ci-image-name"
                type="text"
                value={formData.imageName}
                onChange={(e) => setFormData({ ...formData, imageName: e.target.value })}
                placeholder="ghcr.io/my-org/my-app"
                className="font-mono text-sm"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ci-tag-filter">Tag Filter</Label>
              <Input
                id="ci-tag-filter"
                type="text"
                value={formData.tagFilter}
                onChange={(e) => setFormData({ ...formData, tagFilter: e.target.value })}
                placeholder="latest, v*"
                className="font-mono text-sm"
                required
              />
              <p className="text-xs text-muted-foreground">Comma-separated glob patterns (e.g., latest, v*, *-alpine)</p>
            </div>

            <div className="space-y-1.5">
              <Label>Registry Connection</Label>
              <Select
                value={formData.registryConnectionId || REGISTRY_NONE}
                onValueChange={(value) =>
                  setFormData({
                    ...formData,
                    registryConnectionId: value === REGISTRY_NONE ? null : value,
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={REGISTRY_NONE}>None</SelectItem>
                  {registries.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Auto-update toggle - only shown when editing and has registry */}
            {editingId && formData.registryConnectionId && (
              <div className="flex items-center justify-between pt-2">
                <div>
                  <Label htmlFor="ci-auto-update" className="text-foreground font-medium">Auto-update</Label>
                  <p className="text-xs text-muted-foreground">
                    Automatically deploy when new tags are detected
                  </p>
                </div>
                <Switch
                  id="ci-auto-update"
                  checked={editAutoUpdate}
                  onCheckedChange={setEditAutoUpdate}
                />
              </div>
            )}

            <DialogFooter className="pt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowCreate(false);
                  resetForm();
                  setEditingId(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving...' : editingId ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Deploy Modal */}
      <Dialog
        open={!!(deployingImage && deployingImage.latestDigest)}
        onOpenChange={(open) => {
          if (!open) setDeployingImage(null);
        }}
      >
        {deployingImage && deployingImage.latestDigest && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Deploy {deployingImage.name}</DialogTitle>
              <DialogDescription>
                Deploy latest digest to {deployingImage.services.length} linked service
                {deployingImage.services.length !== 1 ? 's' : ''} in dependency order.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="bg-muted/50 rounded p-3">
                <div className="text-sm text-muted-foreground mb-1">Digest</div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-foreground text-sm">{deployDigestShort}</span>
                  <CopyButton value={deployingImage.latestDigest.manifestDigest} size="icon-xs" />
                </div>
                {deployingImage.latestDigest.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {deployingImage.latestDigest.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">{tag}</Badge>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="text-sm text-muted-foreground mb-2">
                  Services to update ({deployingImage.services.length}):
                </div>
                <div className="space-y-1">
                  {deployingImage.services.map((s: any) => (
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
                  id="autoRollback"
                  checked={deployAutoRollback}
                  onCheckedChange={(checked) => setDeployAutoRollback(checked === true)}
                />
                <Label htmlFor="autoRollback" className="text-muted-foreground">
                  Auto-rollback on failure
                </Label>
              </div>
            </div>

            <DialogFooter className="pt-4">
              <Button type="button" variant="ghost" onClick={() => setDeployingImage(null)}>
                Cancel
              </Button>
              <Button onClick={handleDeploy} disabled={deploying}>
                {deploying ? 'Starting Deploy...' : 'Deploy'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      {/* Link Services Modal */}
      <Dialog
        open={!!linkingImage}
        onOpenChange={(open) => {
          if (!open) {
            setLinkingImage(null);
            setLinkableServices([]);
          }
        }}
      >
        {linkingImage && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Link Services to {linkingImage.name}</DialogTitle>
              <DialogDescription>
                Services that can be linked to this container image
              </DialogDescription>
            </DialogHeader>

            {loadingLinkable ? (
              <Skeleton className="h-10 w-full" />
            ) : linkableServices.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No services available to link.
              </p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {linkableServices.map((service) => (
                  <div
                    key={service.id}
                    className="flex items-center justify-between p-3 bg-muted/50 rounded"
                  >
                    <div>
                      <span className="text-foreground">{service.name}</span>
                      <span className="text-muted-foreground text-sm ml-2">
                        on {(service as Service & { server: { name: string } }).server?.name}
                      </span>
                    </div>
                    <Button size="sm" onClick={() => handleLinkService(service.id)}>
                      Link
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <DialogFooter className="pt-4">
              <Button
                variant="ghost"
                onClick={() => {
                  setLinkingImage(null);
                  setLinkableServices([]);
                }}
              >
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

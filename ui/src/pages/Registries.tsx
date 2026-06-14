import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store.js';
import { toast } from '@/components/Toast';
import { getErrorMessage } from '@/lib/helpers';
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
import { usePagination } from '../hooks/usePagination.js';
import { Boxes, Pencil, Trash2 } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { Skeleton } from '@/components/ui/skeleton';

const REGISTRY_TYPES = [
  { value: 'digitalocean', label: 'DigitalOcean', url: 'https://api.digitalocean.com/v2/registry' },
  { value: 'dockerhub', label: 'Docker Hub', url: 'https://hub.docker.com' },
  { value: 'generic', label: 'Generic Registry', url: '' },
] as const;

export default function Registries() {
  const { selectedEnvironment } = useAppStore();
  const confirm = useConfirm();
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
        .catch((err) => toast.error(getErrorMessage(err, 'Failed to load registries')))
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
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to save registry'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const registry = registries.find((r) => r.id === id);
    if (!registry) return;
    const ok = await confirm({
      title: `Delete registry connection "${registry.name}"?`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;

    try {
      await deleteRegistryConnection(id);
      setRegistries((prev) => prev.filter((r) => r.id !== id));
      toast.success('Registry deleted');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Delete failed'));
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
        message: getErrorMessage(error, 'Test failed'),
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
      toast.error(getErrorMessage(error, 'Failed to load linked services'));
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
      toast.error(getErrorMessage(error, 'Failed to check updates'));
    } finally {
      setCheckingUpdates(null);
    }
  };

  const handleUpdateService = async (service: RegistryService) => {
    if (!service.containerImage?.updateAvailable) return;
    setUpdatingService(service.id);
    try {
      await deployService(service.id, { pullImage: true });
      toast.success(`Redeployed ${service.name} across all deployments`);
      if (viewingServices) {
        const { services } = await getRegistryServices(viewingServices);
        setLinkedServices(services);
      }
    } catch (error) {
      toast.error(getErrorMessage(error, 'Update failed'));
    } finally {
      setUpdatingService(null);
    }
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
        <div className="rounded-lg border bg-card p-4 text-center py-12">
          <p className="text-muted-foreground">Select an environment to view registries</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-5">
        <Button onClick={openCreate}>Add Registry</Button>
      </div>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : registries.length === 0 ? (
        <EmptyState
          icon={Boxes}
          message="No registry connections configured"
          description="Connect a container registry to enable automatic update checking for services"
          action={{ label: 'Add Your First Registry', onClick: openCreate }}
        />
      ) : (
        <div className="space-y-4">
          {paginatedData.map((registry) => (
            <Card key={registry.id} className="gap-0 py-4 px-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-muted rounded-lg">
                    <Boxes className="size-6 text-primary" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-foreground">{registry.name}</h3>
                      {registry.isDefault && (
                        <Badge variant="info" className="text-xs">Default</Badge>
                      )}
                      <Badge variant="secondary" className="text-xs">
                        {REGISTRY_TYPES.find((t) => t.value === registry.type)?.label || registry.type}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-sm mt-1 font-mono">{registry.registryUrl}</p>
                    {registry.repositoryPrefix && (
                      <p className="text-muted-foreground text-sm">Prefix: {registry.repositoryPrefix}</p>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      <span>
                        {registry._count?.services || 0} service{registry._count?.services !== 1 ? 's' : ''}
                      </span>
                      <span>Refresh: {registry.refreshIntervalMinutes}m</span>
                      {registry.autoLinkPattern && (
                        <span className="text-primary">Auto-link: {registry.autoLinkPattern}</span>
                      )}
                      <span>
                        Updated {formatDistanceToNow(new Date(registry.updatedAt), { addSuffix: true })}
                      </span>
                    </div>
                    {testResult?.id === registry.id && (
                      <div
                        className={`mt-2 text-sm ${
                          testResult.success ? 'text-success' : 'text-destructive'
                        }`}
                      >
                        {testResult.message}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {(registry._count?.services || 0) > 0 && (
                    <>
                      <Button
                        onClick={() => handleCheckUpdates(registry.id)}
                        disabled={checkingUpdates === registry.id}
                        size="sm"
                      >
                        {checkingUpdates === registry.id ? 'Checking...' : 'Check Updates'}
                      </Button>
                      <Button
                        onClick={() => handleViewServices(registry.id)}
                        variant="ghost"
                        size="sm"
                      >
                        {viewingServices === registry.id ? 'Hide Services' : 'View Services'}
                      </Button>
                    </>
                  )}
                  <Button
                    onClick={() => handleTest(registry.id)}
                    disabled={testing === registry.id}
                    variant="ghost"
                    size="sm"
                  >
                    {testing === registry.id ? 'Testing...' : 'Test'}
                  </Button>
                  <Button
                    onClick={() => openEdit(registry)}
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground"
                    title="Edit"
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    onClick={() => handleDelete(registry.id)}
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={(registry._count?.services || 0) > 0}
                    title={
                      (registry._count?.services || 0) > 0
                        ? 'Cannot delete registry with attached services'
                        : 'Delete'
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>

              {/* Linked Services */}
              {viewingServices === registry.id && (
                <div className="mt-4 pt-4 border-t">
                  <h4 className="text-sm font-medium text-muted-foreground mb-3">Linked Services</h4>
                  {loadingServices ? (
                    <div className="space-y-2">
                      <Skeleton className="h-8 w-full rounded" />
                      <Skeleton className="h-8 w-full rounded" />
                    </div>
                  ) : linkedServices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No services linked to this registry</p>
                  ) : (
                    <div className="space-y-2">
                      {linkedServices.map((service) => {
                        const image = service.containerImage;
                        const hasUpdate = !!image?.updateAvailable;
                        const servers = service.serviceDeployments
                          .map((d) => d.server.name)
                          .join(', ');
                        return (
                          <div
                            key={service.id}
                            className="flex items-center justify-between p-3 bg-muted/50 rounded"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Link
                                  to={`/services/${service.id}`}
                                  className="text-foreground hover:text-primary font-medium"
                                >
                                  {service.name}
                                </Link>
                                {servers && (
                                  <span className="text-muted-foreground text-sm">on {servers}</span>
                                )}
                                {image?.autoUpdate && (
                                  <Badge variant="info" className="text-xs">Auto-update</Badge>
                                )}
                                {hasUpdate && (
                                  <Badge variant="warning" className="text-xs">Update available</Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground font-mono mt-1 truncate">
                                {image?.imageName}
                              </p>
                              <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                                <span className="font-mono">
                                  Tag: <span className="text-foreground">{service.imageTag}</span>
                                </span>
                                {image?.tagFilter && (
                                  <span className="font-mono">
                                    Filter: <span className="text-foreground">{image.tagFilter}</span>
                                  </span>
                                )}
                                {image?.lastCheckedAt && (
                                  <span>
                                    Checked {formatDistanceToNow(new Date(image.lastCheckedAt), { addSuffix: true })}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                              {hasUpdate && (
                                <Button
                                  onClick={() => handleUpdateService(service)}
                                  disabled={updatingService === service.id}
                                  size="sm"
                                >
                                  {updatingService === service.id ? 'Updating...' : 'Update'}
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}
          <DataPagination
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
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingId ? 'Edit Registry Connection' : 'Add Registry Connection'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="reg-name">Name</Label>
              <Input
                id="reg-name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="My Registry"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={formData.type}
                onValueChange={(value) =>
                  handleTypeChange(value as 'digitalocean' | 'dockerhub' | 'generic')
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REGISTRY_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reg-url">Registry URL</Label>
              <Input
                id="reg-url"
                type="text"
                value={formData.registryUrl}
                onChange={(e) => setFormData({ ...formData, registryUrl: e.target.value })}
                placeholder="https://registry.example.com"
                className="font-mono text-sm"
                required
              />
            </div>

            {formData.type === 'digitalocean' && (
              <div className="space-y-1.5">
                <Label htmlFor="reg-prefix">Repository Prefix (Registry Name)</Label>
                <Input
                  id="reg-prefix"
                  type="text"
                  value={formData.repositoryPrefix}
                  onChange={(e) => setFormData({ ...formData, repositoryPrefix: e.target.value })}
                  placeholder="my-registry"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  The registry name from DigitalOcean (e.g., my-registry)
                </p>
              </div>
            )}

            {formData.type === 'digitalocean' && (
              <div className="space-y-1.5">
                <Label htmlFor="reg-token">API Token</Label>
                <Input
                  id="reg-token"
                  type="password"
                  value={formData.token}
                  onChange={(e) => setFormData({ ...formData, token: e.target.value })}
                  placeholder={editingId ? '(unchanged)' : 'dop_v1_...'}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  DigitalOcean API token with registry read access
                </p>
              </div>
            )}

            {(formData.type === 'dockerhub' || formData.type === 'generic') && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-username">Username</Label>
                  <Input
                    id="reg-username"
                    type="text"
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    placeholder="username"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-password">Password / Token</Label>
                  <Input
                    id="reg-password"
                    type="password"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder={editingId ? '(unchanged)' : 'password or access token'}
                  />
                </div>
              </>
            )}

            <Label className="flex items-center gap-2 text-sm font-normal">
              <Checkbox
                id="isDefault"
                checked={formData.isDefault}
                onCheckedChange={(checked) => setFormData({ ...formData, isDefault: checked === true })}
              />
              <span className="text-foreground">Set as default registry for this environment</span>
            </Label>

            <div className="space-y-1.5">
              <Label htmlFor="reg-refresh">Refresh Interval (minutes)</Label>
              <Input
                id="reg-refresh"
                type="number"
                min={5}
                max={1440}
                value={formData.refreshIntervalMinutes}
                onChange={(e) =>
                  setFormData({ ...formData, refreshIntervalMinutes: parseInt(e.target.value) || 30 })
                }
              />
              <p className="text-xs text-muted-foreground">
                How often to check for image updates (5-1440 minutes)
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reg-autolink">Auto-link Pattern (optional)</Label>
              <Input
                id="reg-autolink"
                type="text"
                value={formData.autoLinkPattern}
                onChange={(e) => setFormData({ ...formData, autoLinkPattern: e.target.value })}
                placeholder="bios-*"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Automatically link services matching this pattern (e.g., "bios-*", "app-*")
              </p>
            </div>

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
    </div>
  );
}

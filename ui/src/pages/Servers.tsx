import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore, useAuthStore, isAdmin } from '../lib/store.js';
import { usePaginatedFetch } from '../hooks/usePaginatedFetch.js';
import { listServers, checkServerHealth, discoverContainers, createServer, deleteServer, getHostInfo, registerHost, getHealthLogs, type Server, type HostInfo, type HealthCheckLog } from '../lib/api.js';
import { formatDistanceToNow } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '../components/Toast.js';
import { ServerIcon, HeartPulseIcon, TrashIcon } from '../components/Icons.js';
import { safeJsonParse } from '../lib/helpers.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { DataPagination } from '@/components/ui/data-pagination';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function Servers() {
  const { selectedEnvironment } = useAppStore();
  const { user } = useAuthStore();
  const toast = useToast();
  const { items: servers, total, loading, currentPage, pageSize, totalPages, setCurrentPage, setPageSize, reload } =
    usePaginatedFetch({
      fetcher: ({ limit, offset }) =>
        listServers(selectedEnvironment!.id, { limit, offset }).then(r => ({
          items: r.servers,
          total: r.total,
        })),
      deps: [selectedEnvironment?.id],
      enabled: !!selectedEnvironment?.id,
    });
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newHostname, setNewHostname] = useState('');
  const [newPublicIp, setNewPublicIp] = useState('');
  const [newTags, setNewTags] = useState('');
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [hostBannerDismissed, setHostBannerDismissed] = useState(false);
  const [registeringHost, setRegisteringHost] = useState(false);
  const [healthLogs, setHealthLogs] = useState<HealthCheckLog[]>([]);
  const [serverToDelete, setServerToDelete] = useState<Server | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadHealthLogs = async (envId: string) => {
    try {
      const { logs } = await getHealthLogs(envId, { type: 'server', limit: 20, hours: 24 });
      setHealthLogs(logs);
    } catch {
      setHealthLogs([]);
    }
  };

  useEffect(() => {
    if (selectedEnvironment?.id) {
      getHostInfo(selectedEnvironment.id).catch(() => null).then(setHostInfo);
      loadHealthLogs(selectedEnvironment.id);
    }
  }, [selectedEnvironment?.id]);

  const resetCreateForm = () => {
    setNewName('');
    setNewHostname('');
    setNewPublicIp('');
    setNewTags('');
  };

  const handleRegisterHost = async () => {
    if (!selectedEnvironment?.id || !hostInfo?.detected) return;
    setRegisteringHost(true);
    try {
      const { server } = await registerHost(selectedEnvironment.id);
      reload();
      setHostInfo((prev) => prev ? { ...prev, registered: true, serverId: server.id } : null);
      toast.success('Host server registered successfully');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to register host');
    } finally {
      setRegisteringHost(false);
    }
  };

  const handleHealthCheck = async (serverId: string) => {
    setActionLoading(serverId);
    try {
      await checkServerHealth(serverId);
      reload();
      // Reload health logs to show new entry
      if (selectedEnvironment?.id) {
        loadHealthLogs(selectedEnvironment.id);
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleDiscover = async (serverId: string) => {
    setActionLoading(serverId);
    try {
      await discoverContainers(serverId);
      reload();
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;
    setCreating(true);
    try {
      const tags = newTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      await createServer(selectedEnvironment.id, {
        name: newName,
        hostname: newHostname,
        publicIp: newPublicIp || undefined,
        tags: tags.length > 0 ? tags : undefined,
      });
      reload();
      setShowCreate(false);
      resetCreateForm();
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!serverToDelete || !selectedEnvironment?.id) return;
    setDeleting(true);
    try {
      await deleteServer(serverToDelete.id);
      reload();
      toast.success(`Server "${serverToDelete.name}" deleted`);
      setServerToDelete(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete server');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-5">
        <Button onClick={() => setShowCreate(true)}>Add Server</Button>
      </div>

      {/* Host Detection Banner - only show if not registered in ANY environment */}
      {hostInfo?.detected && !hostInfo.registeredGlobally && !hostBannerDismissed && (
        <Alert
          variant={hostInfo.sshReachable ? 'info' : 'warning'}
          className="mb-4"
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <AlertTitle>
                {hostInfo.sshReachable
                  ? 'Docker host detected and reachable'
                  : 'Docker host detected but SSH not reachable'}
              </AlertTitle>
              <AlertDescription className="mt-0.5">
                {hostInfo.sshReachable ? (
                  <>
                    Gateway IP: <code className="bg-muted px-1 rounded">{hostInfo.gatewayIp}</code>.
                    Add it to manage services on this machine.
                  </>
                ) : (
                  <>
                    {hostInfo.sshError || 'SSH connection failed'}.
                    Ensure SSH is configured and the host allows connections from the container network.
                  </>
                )}
              </AlertDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {hostInfo.sshReachable && (
                <Button
                  size="sm"
                  onClick={handleRegisterHost}
                  disabled={registeringHost}
                  className="whitespace-nowrap"
                >
                  {registeringHost ? 'Adding...' : 'Add Host Server'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHostBannerDismissed(true)}
              >
                Dismiss
              </Button>
            </div>
          </div>
        </Alert>
      )}

      {/* Create Server Modal */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreate(false);
            resetCreateForm();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Server</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="server-name">Name</Label>
              <Input
                id="server-name"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="gateway-1"
                required
              />
              <p className="text-xs text-muted-foreground">
                Human-readable name for the server
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="server-hostname">Hostname</Label>
              <Input
                id="server-hostname"
                type="text"
                value={newHostname}
                onChange={(e) => setNewHostname(e.target.value)}
                placeholder="10.20.10.2"
                required
              />
              <p className="text-xs text-muted-foreground">
                Private IP or hostname for SSH access
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="server-public-ip">Public IP (optional)</Label>
              <Input
                id="server-public-ip"
                type="text"
                value={newPublicIp}
                onChange={(e) => setNewPublicIp(e.target.value)}
                placeholder="203.0.113.10"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="server-tags">Tags (optional)</Label>
              <Input
                id="server-tags"
                type="text"
                value={newTags}
                onChange={(e) => setNewTags(e.target.value)}
                placeholder="web, production"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated list of tags
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowCreate(false);
                  resetCreateForm();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? 'Creating...' : 'Add Server'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Modal */}
      <Dialog open={!!serverToDelete} onOpenChange={(open) => !open && setServerToDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Server</DialogTitle>
            <DialogDescription>
              This will remove the server and all its associated services from BRIDGEPORT. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-foreground">
            Are you sure you want to delete <span className="font-semibold">{serverToDelete?.name}</span>?
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setServerToDelete(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting...' : 'Delete Server'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="space-y-4">
        {servers.map((server) => {
          const tags = safeJsonParse(server.tags, [] as string[]);
          return (
            <Card key={server.id} className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-info/10 rounded-lg">
                    <ServerIcon className="w-6 h-6 text-info" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        to={`/servers/${server.id}`}
                        className="text-lg font-semibold text-foreground hover:text-primary"
                      >
                        {server.name}
                      </Link>
                      <StatusBadge kind="server" value={server.status} label={server.status || 'unknown'} />
                      {server.serverType === 'host' && (
                        <Badge variant="info">Host</Badge>
                      )}
                      {tags.map((tag: string) => (
                        <Badge key={tag} variant="neutral">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-muted-foreground text-sm mt-1 font-mono">
                      {server.hostname}
                      {server.publicIp && (
                        <span className="text-muted-foreground"> · Public: {server.publicIp}</span>
                      )}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      <span>
                        {server.lastCheckedAt
                          ? `Checked ${formatDistanceToNow(new Date(server.lastCheckedAt), { addSuffix: true })}`
                          : 'Never checked'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => handleDiscover(server.id)}
                    disabled={actionLoading === server.id}
                    size="sm"
                  >
                    {actionLoading === server.id ? 'Loading...' : 'Discover'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleHealthCheck(server.id)}
                    disabled={actionLoading === server.id}
                    title="Health Check"
                  >
                    <HeartPulseIcon className="w-4 h-4" />
                  </Button>
                  {isAdmin(user) && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setServerToDelete(server)}
                      title="Delete"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          );
        })}

        {total === 0 && (
          <EmptyState
            icon={ServerIcon}
            message="No servers configured"
            description="Add a server to start managing your infrastructure"
            action={{ label: 'Add Your First Server', onClick: () => setShowCreate(true) }}
          />
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
      </div>

      {/* Recent Health Checks */}
      {healthLogs.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-foreground">Recent Health Checks</h2>
            <Link to="/monitoring/health" className="text-sm text-muted-foreground hover:text-foreground">
              View all
            </Link>
          </div>
          <Card className="overflow-hidden p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {healthLogs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-muted-foreground">
                      {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                    </TableCell>
                    <TableCell>
                      <Link
                        to={`/servers/${log.resourceId}`}
                        className="text-foreground hover:text-primary"
                      >
                        {log.resourceName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        kind="deployment"
                        value={log.status}
                        label={log.status}
                        variant={
                          log.status === 'success'
                            ? 'success'
                            : log.status === 'failure'
                            ? 'destructive'
                            : 'warning'
                        }
                        dot
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {log.durationMs !== null ? `${log.durationMs}ms` : '-'}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-xs truncate">
                      {log.errorMessage || '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}
    </div>
  );
}

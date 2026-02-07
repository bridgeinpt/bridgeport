import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore, useAuthStore, isAdmin } from '../lib/store.js';
import { listServers, checkServerHealth, discoverContainers, createServer, deleteServer, getHostInfo, registerHost, getHealthLogs, type Server, type HostInfo, type HealthCheckLog } from '../lib/api.js';
import { formatDistanceToNow } from 'date-fns';
import { Modal } from '../components/Modal.js';
import Pagination from '../components/Pagination.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { EmptyState } from '../components/EmptyState.js';
import { Alert } from '../components/Alert.js';
import { useToast } from '../components/Toast.js';
import { ServerIcon, HeartPulseIcon, TrashIcon } from '../components/Icons.js';

export default function Servers() {
  const { selectedEnvironment } = useAppStore();
  const { user } = useAuthStore();
  const toast = useToast();
  const [servers, setServers] = useState<Server[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
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
      setLoading(true);
      const offset = (currentPage - 1) * pageSize;
      Promise.all([
        listServers(selectedEnvironment.id, { limit: pageSize, offset }),
        getHostInfo(selectedEnvironment.id).catch(() => null),
      ])
        .then(([serversRes, hostInfoRes]) => {
          setServers(serversRes.servers);
          setTotalItems(serversRes.total);
          setHostInfo(hostInfoRes);
        })
        .finally(() => setLoading(false));

      loadHealthLogs(selectedEnvironment.id);
    }
  }, [selectedEnvironment?.id, currentPage, pageSize]);

  const handleRegisterHost = async () => {
    if (!selectedEnvironment?.id || !hostInfo?.detected) return;
    setRegisteringHost(true);
    try {
      const { server } = await registerHost(selectedEnvironment.id);
      // Re-fetch to update paginated list
      const offset = (currentPage - 1) * pageSize;
      const res = await listServers(selectedEnvironment.id, { limit: pageSize, offset });
      setServers(res.servers);
      setTotalItems(res.total);
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
      const result = await checkServerHealth(serverId);
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? { ...s, status: result.status, lastCheckedAt: new Date().toISOString() }
            : s
        )
      );
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
      // Reload to see new services
      if (selectedEnvironment?.id) {
        const offset = (currentPage - 1) * pageSize;
        const res = await listServers(selectedEnvironment.id, { limit: pageSize, offset });
        setServers(res.servers);
        setTotalItems(res.total);
      }
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
      // Re-fetch to update paginated list
      const offset = (currentPage - 1) * pageSize;
      const res = await listServers(selectedEnvironment.id, { limit: pageSize, offset });
      setServers(res.servers);
      setTotalItems(res.total);
      setShowCreate(false);
      setNewName('');
      setNewHostname('');
      setNewPublicIp('');
      setNewTags('');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!serverToDelete || !selectedEnvironment?.id) return;
    setDeleting(true);
    try {
      await deleteServer(serverToDelete.id);
      // Re-fetch to update paginated list
      const offset = (currentPage - 1) * pageSize;
      const res = await listServers(selectedEnvironment.id, { limit: pageSize, offset });
      setServers(res.servers);
      setTotalItems(res.total);
      toast.success(`Server "${serverToDelete.name}" deleted`);
      setServerToDelete(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete server');
    } finally {
      setDeleting(false);
    }
  };

  const totalPages = Math.ceil(totalItems / pageSize);

  if (loading) {
    return <LoadingSkeleton rows={3} rowHeight="h-20" />;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Manage servers in {selectedEnvironment?.name}
        </p>
        <button onClick={() => setShowCreate(true)} className="btn btn-primary">Add Server</button>
      </div>

      {/* Host Detection Banner - only show if not registered in ANY environment */}
      {hostInfo?.detected && !hostInfo.registeredGlobally && !hostBannerDismissed && (
        <Alert
          variant={hostInfo.sshReachable ? 'info' : 'warning'}
          className="mb-4"
          onDismiss={() => setHostBannerDismissed(true)}
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">
                {hostInfo.sshReachable
                  ? 'Docker host detected and reachable'
                  : 'Docker host detected but SSH not reachable'}
              </p>
              <p className="text-sm opacity-80 mt-0.5">
                {hostInfo.sshReachable ? (
                  <>
                    Gateway IP: <code className="bg-black/20 px-1 rounded">{hostInfo.gatewayIp}</code>.
                    Add it to manage services on this machine.
                  </>
                ) : (
                  <>
                    {hostInfo.sshError || 'SSH connection failed'}.
                    Ensure SSH is configured and the host allows connections from the container network.
                  </>
                )}
              </p>
            </div>
            {hostInfo.sshReachable && (
              <button
                onClick={handleRegisterHost}
                disabled={registeringHost}
                className="btn btn-primary btn-sm whitespace-nowrap"
              >
                {registeringHost ? 'Adding...' : 'Add Host Server'}
              </button>
            )}
          </div>
        </Alert>
      )}

      {/* Create Server Modal */}
      <Modal
        isOpen={showCreate}
        onClose={() => {
          setShowCreate(false);
          setNewName('');
          setNewHostname('');
          setNewPublicIp('');
          setNewTags('');
        }}
        title="Add Server"
        size="md"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="gateway-1"
              className="input"
              required
            />
            <p className="text-xs text-slate-500 mt-1">
              Human-readable name for the server
            </p>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Hostname</label>
            <input
              type="text"
              value={newHostname}
              onChange={(e) => setNewHostname(e.target.value)}
              placeholder="10.20.10.2"
              className="input"
              required
            />
            <p className="text-xs text-slate-500 mt-1">
              Private IP or hostname for SSH access
            </p>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Public IP (optional)</label>
            <input
              type="text"
              value={newPublicIp}
              onChange={(e) => setNewPublicIp(e.target.value)}
              placeholder="203.0.113.10"
              className="input"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Tags (optional)</label>
            <input
              type="text"
              value={newTags}
              onChange={(e) => setNewTags(e.target.value)}
              placeholder="web, production"
              className="input"
            />
            <p className="text-xs text-slate-500 mt-1">
              Comma-separated list of tags
            </p>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                setNewName('');
                setNewHostname('');
                setNewPublicIp('');
                setNewTags('');
              }}
              className="btn btn-ghost"
            >
              Cancel
            </button>
            <button type="submit" disabled={creating} className="btn btn-primary">
              {creating ? 'Creating...' : 'Add Server'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!serverToDelete}
        onClose={() => setServerToDelete(null)}
        title="Delete Server"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-slate-300">
            Are you sure you want to delete <span className="font-semibold text-white">{serverToDelete?.name}</span>?
          </p>
          <p className="text-sm text-slate-400">
            This will remove the server and all its associated services from BridgePort. This action cannot be undone.
          </p>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setServerToDelete(null)}
              className="btn btn-ghost"
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="btn bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? 'Deleting...' : 'Delete Server'}
            </button>
          </div>
        </div>
      </Modal>

      <div className="space-y-4">
        {servers.map((server) => {
          const tags = server.tags ? JSON.parse(server.tags) : [];
          return (
            <div key={server.id} className="panel">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-slate-800 rounded-lg">
                    <ServerIcon className="w-6 h-6 text-primary-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        to={`/servers/${server.id}`}
                        className="text-lg font-semibold text-white hover:text-primary-400"
                      >
                        {server.name}
                      </Link>
                      <span
                        className={`badge text-xs ${
                          server.status === 'healthy'
                            ? 'bg-green-500/20 text-green-400'
                            : server.status === 'unhealthy'
                            ? 'bg-red-500/20 text-red-400'
                            : 'bg-yellow-500/20 text-yellow-400'
                        }`}
                      >
                        {server.status || 'unknown'}
                      </span>
                      {server.serverType === 'host' && (
                        <span className="badge bg-purple-500/20 text-purple-400 text-xs">
                          Host
                        </span>
                      )}
                      {tags.map((tag: string) => (
                        <span
                          key={tag}
                          className="badge bg-slate-700 text-slate-300 text-xs"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    <p className="text-slate-400 text-sm mt-1 font-mono">
                      {server.hostname}
                      {server.publicIp && (
                        <span className="text-slate-500"> · Public: {server.publicIp}</span>
                      )}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                      <span>
                        {server.lastCheckedAt
                          ? `Checked ${formatDistanceToNow(new Date(server.lastCheckedAt), { addSuffix: true })}`
                          : 'Never checked'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDiscover(server.id)}
                    disabled={actionLoading === server.id}
                    className="btn btn-primary text-sm"
                  >
                    {actionLoading === server.id ? 'Loading...' : 'Discover'}
                  </button>
                  <button
                    onClick={() => handleHealthCheck(server.id)}
                    disabled={actionLoading === server.id}
                    className="p-1.5 text-slate-400 hover:text-white rounded"
                    title="Health Check"
                  >
                    <HeartPulseIcon className="w-4 h-4" />
                  </button>
                  {isAdmin(user) && (
                    <button
                      onClick={() => setServerToDelete(server)}
                      className="p-1.5 text-slate-400 hover:text-red-400 rounded"
                      title="Delete"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {totalItems === 0 && (
          <EmptyState
            icon={ServerIcon}
            message="No servers configured"
            description="Add a server to start managing your infrastructure"
            action={{ label: 'Add Your First Server', onClick: () => setShowCreate(true) }}
          />
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
      </div>

      {/* Recent Health Checks */}
      {healthLogs.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Recent Health Checks</h2>
            <Link to="/monitoring/health" className="text-sm text-slate-400 hover:text-white">
              View all
            </Link>
          </div>
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">Time</th>
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">Server</th>
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">Status</th>
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">Duration</th>
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {healthLogs.map((log) => (
                  <tr key={log.id} className="border-b border-slate-800 last:border-0">
                    <td className="py-3 px-4 text-slate-400">
                      {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                    </td>
                    <td className="py-3 px-4">
                      <Link
                        to={`/servers/${log.resourceId}`}
                        className="text-white hover:text-primary-400"
                      >
                        {log.resourceName}
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${
                          log.status === 'success'
                            ? 'bg-green-500/20 text-green-400'
                            : log.status === 'failure'
                            ? 'bg-red-500/20 text-red-400'
                            : 'bg-yellow-500/20 text-yellow-400'
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            log.status === 'success'
                              ? 'bg-green-400'
                              : log.status === 'failure'
                              ? 'bg-red-400'
                              : 'bg-yellow-400'
                          }`}
                        />
                        {log.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-400">
                      {log.durationMs !== null ? `${log.durationMs}ms` : '-'}
                    </td>
                    <td className="py-3 px-4 text-slate-500 max-w-xs truncate">
                      {log.errorMessage || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

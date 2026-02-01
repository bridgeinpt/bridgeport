import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { listServers, checkServerHealth, discoverContainers, type Server } from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

export default function Servers() {
  const { selectedEnvironment } = useAppStore();
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      listServers(selectedEnvironment.id)
        .then(({ servers }) => setServers(servers))
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id]);

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
        const { servers } = await listServers(selectedEnvironment.id);
        setServers(servers);
      }
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-32 bg-slate-700 rounded mb-8"></div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Servers</h1>
          <p className="text-slate-400">
            Manage servers in {selectedEnvironment?.name}
          </p>
        </div>
        <button className="btn btn-primary">Add Server</button>
      </div>

      <div className="space-y-4">
        {servers.map((server) => (
          <div key={server.id} className="card">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div
                  className={`w-3 h-3 rounded-full ${
                    server.status === 'healthy'
                      ? 'bg-green-500'
                      : server.status === 'unhealthy'
                      ? 'bg-red-500'
                      : 'bg-yellow-500'
                  }`}
                />
                <div>
                  <Link
                    to={`/servers/${server.id}`}
                    className="text-lg font-semibold text-white hover:text-primary-400"
                  >
                    {server.name}
                  </Link>
                  <div className="flex items-center gap-4 mt-1 text-sm text-slate-400">
                    <span className="font-mono">{server.hostname}</span>
                    {server.publicIp && (
                      <span className="font-mono">Public: {server.publicIp}</span>
                    )}
                    <span>
                      {server.lastCheckedAt
                        ? `Checked ${formatDistanceToNow(new Date(server.lastCheckedAt), {
                            addSuffix: true,
                          })}`
                        : 'Never checked'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDiscover(server.id)}
                  disabled={actionLoading === server.id}
                  className="btn btn-ghost text-sm"
                >
                  {actionLoading === server.id ? 'Loading...' : 'Discover'}
                </button>
                <button
                  onClick={() => handleHealthCheck(server.id)}
                  disabled={actionLoading === server.id}
                  className="btn btn-secondary text-sm"
                >
                  {actionLoading === server.id ? 'Checking...' : 'Health Check'}
                </button>
              </div>
            </div>

            {/* Tags */}
            {server.tags && JSON.parse(server.tags).length > 0 && (
              <div className="mt-4 flex gap-2">
                {JSON.parse(server.tags).map((tag: string) => (
                  <span
                    key={tag}
                    className="px-2 py-1 bg-slate-700 rounded text-xs text-slate-300"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {servers.length === 0 && (
          <div className="card text-center py-12">
            <p className="text-slate-400">No servers configured</p>
            <button className="btn btn-primary mt-4">Add First Server</button>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getServer, checkServerHealth, discoverContainers, deleteService, type ServerWithServices } from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

export default function ServerDetail() {
  const { id } = useParams<{ id: string }>();
  const [server, setServer] = useState<ServerWithServices | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    if (id) {
      setLoading(true);
      getServer(id)
        .then(({ server }) => setServer(server))
        .finally(() => setLoading(false));
    }
  }, [id]);

  const handleHealthCheck = async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      const result = await checkServerHealth(id);
      setServer((prev) =>
        prev
          ? { ...prev, status: result.status, lastCheckedAt: new Date().toISOString() }
          : null
      );
    } finally {
      setActionLoading(false);
    }
  };

  const handleDiscover = async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      const { services } = await discoverContainers(id);
      setServer((prev) => (prev ? { ...prev, services } : null));
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteService = async (serviceId: string, serviceName: string) => {
    if (!confirm(`Delete service "${serviceName}"? This cannot be undone.`)) return;
    try {
      await deleteService(serviceId);
      setServer((prev) =>
        prev ? { ...prev, services: prev.services.filter(s => s.id !== serviceId) } : null
      );
    } catch (error) {
      alert('Failed to delete service');
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-8"></div>
          <div className="h-64 bg-slate-800 rounded-xl"></div>
        </div>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="p-8">
        <div className="card text-center py-12">
          <p className="text-slate-400">Server not found</p>
          <Link to="/servers" className="btn btn-primary mt-4">
            Back to Servers
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="flex items-center gap-3">
            <div
              className={`w-3 h-3 rounded-full ${
                server.status === 'healthy'
                  ? 'bg-green-500'
                  : server.status === 'unhealthy'
                  ? 'bg-red-500'
                  : 'bg-yellow-500'
              }`}
            />
            <h1 className="text-2xl font-bold text-white">{server.name}</h1>
          </div>
          <p className="text-slate-400 mt-1">
            {server.hostname}
            {server.publicIp && ` • Public: ${server.publicIp}`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleDiscover}
            disabled={actionLoading}
            className="btn btn-secondary"
          >
            {actionLoading ? 'Loading...' : 'Discover Containers'}
          </button>
          <button
            onClick={handleHealthCheck}
            disabled={actionLoading}
            className="btn btn-primary"
          >
            {actionLoading ? 'Checking...' : 'Health Check'}
          </button>
        </div>
      </div>

      {/* Server Info */}
      <div className="grid grid-cols-2 gap-6 mb-8">
        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Details</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-slate-400">Status</dt>
              <dd>
                <span
                  className={`badge ${
                    server.status === 'healthy'
                      ? 'badge-success'
                      : server.status === 'unhealthy'
                      ? 'badge-error'
                      : 'badge-warning'
                  }`}
                >
                  {server.status}
                </span>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Private IP</dt>
              <dd className="font-mono text-white">{server.hostname}</dd>
            </div>
            {server.publicIp && (
              <div className="flex justify-between">
                <dt className="text-slate-400">Public IP</dt>
                <dd className="font-mono text-white">{server.publicIp}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-slate-400">Last Checked</dt>
              <dd className="text-white">
                {server.lastCheckedAt
                  ? formatDistanceToNow(new Date(server.lastCheckedAt), {
                      addSuffix: true,
                    })
                  : 'Never'}
              </dd>
            </div>
          </dl>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold text-white mb-4">Tags</h3>
          <div className="flex flex-wrap gap-2">
            {server.tags &&
              JSON.parse(server.tags).map((tag: string) => (
                <span
                  key={tag}
                  className="px-3 py-1 bg-slate-700 rounded-full text-sm text-slate-300"
                >
                  {tag}
                </span>
              ))}
            {(!server.tags || JSON.parse(server.tags).length === 0) && (
              <p className="text-slate-400">No tags</p>
            )}
          </div>
        </div>
      </div>

      {/* Active Services */}
      {(() => {
        const activeServices = server.services.filter(s => s.discoveryStatus !== 'missing');
        const missingServices = server.services.filter(s => s.discoveryStatus === 'missing');

        return (
          <>
            <div className="card mb-6">
              <h3 className="text-lg font-semibold text-white mb-4">
                Services ({activeServices.length})
              </h3>
              {activeServices.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                        <th className="pb-3 font-medium">Name</th>
                        <th className="pb-3 font-medium">Container</th>
                        <th className="pb-3 font-medium">Image</th>
                        <th className="pb-3 font-medium">Status</th>
                        <th className="pb-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                      {activeServices.map((service) => (
                        <tr key={service.id} className="text-slate-300">
                          <td className="py-3">
                            <Link
                              to={`/services/${service.id}`}
                              className="text-white hover:text-primary-400"
                            >
                              {service.name}
                            </Link>
                          </td>
                          <td className="py-3 font-mono text-sm">
                            {service.containerName}
                          </td>
                          <td className="py-3 font-mono text-sm">
                            {service.imageName.split('/').pop()}:{service.imageTag}
                          </td>
                          <td className="py-3">
                            <span
                              className={`badge ${
                                service.status === 'running' || service.status === 'healthy'
                                  ? 'badge-success'
                                  : service.status === 'stopped'
                                  ? 'badge-error'
                                  : 'badge-warning'
                              }`}
                            >
                              {service.status}
                            </span>
                          </td>
                          <td className="py-3 text-right">
                            <Link
                              to={`/services/${service.id}`}
                              className="text-primary-400 hover:text-primary-300 text-sm"
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-slate-400">
                  No services discovered. Click "Discover Containers" to scan for Docker containers.
                </p>
              )}
            </div>

            {/* Missing Services */}
            {missingServices.length > 0 && (
              <div className="card border-orange-500/30">
                <h3 className="text-lg font-semibold text-orange-400 mb-4">
                  Missing Services ({missingServices.length})
                </h3>
                <p className="text-slate-400 text-sm mb-4">
                  These services were previously discovered but are no longer running on the server.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                        <th className="pb-3 font-medium">Name</th>
                        <th className="pb-3 font-medium">Container</th>
                        <th className="pb-3 font-medium">Image</th>
                        <th className="pb-3 font-medium">Last Seen</th>
                        <th className="pb-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                      {missingServices.map((service) => (
                        <tr key={service.id} className="text-slate-400">
                          <td className="py-3">
                            <Link
                              to={`/services/${service.id}`}
                              className="text-slate-300 hover:text-primary-400"
                            >
                              {service.name}
                            </Link>
                          </td>
                          <td className="py-3 font-mono text-sm">
                            {service.containerName}
                          </td>
                          <td className="py-3 font-mono text-sm">
                            {service.imageName.split('/').pop()}:{service.imageTag}
                          </td>
                          <td className="py-3">
                            {service.lastDiscoveredAt
                              ? formatDistanceToNow(new Date(service.lastDiscoveredAt), {
                                  addSuffix: true,
                                })
                              : 'Unknown'}
                          </td>
                          <td className="py-3 text-right space-x-3">
                            <Link
                              to={`/services/${service.id}`}
                              className="text-primary-400 hover:text-primary-300 text-sm"
                            >
                              View
                            </Link>
                            <button
                              onClick={() => handleDeleteService(service.id, service.name)}
                              className="text-red-400 hover:text-red-300 text-sm"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

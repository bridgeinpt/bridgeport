import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { getEnvironment, type EnvironmentWithServers } from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

export default function Dashboard() {
  const { selectedEnvironment } = useAppStore();
  const [environment, setEnvironment] = useState<EnvironmentWithServers | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      getEnvironment(selectedEnvironment.id)
        .then(({ environment }) => setEnvironment(environment))
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id]);

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-8"></div>
          <div className="grid grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!environment) {
    return (
      <div className="p-8">
        <div className="card text-center py-12">
          <p className="text-slate-400">No environment selected</p>
        </div>
      </div>
    );
  }

  const serverCount = environment.servers.length;
  const serviceCount = environment.servers.reduce(
    (acc, s) => acc + s.services.length,
    0
  );
  const healthyServers = environment.servers.filter(
    (s) => s.status === 'healthy'
  ).length;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white capitalize">
            {environment.name} Environment
          </h1>
          <p className="text-slate-400">Overview of your infrastructure</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-slate-400 text-sm">Servers</p>
              <p className="text-3xl font-bold text-white mt-1">{serverCount}</p>
            </div>
            <div className="w-12 h-12 bg-primary-900/50 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
              </svg>
            </div>
          </div>
          <div className="mt-4">
            <span className="badge badge-success">
              {healthyServers} healthy
            </span>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-slate-400 text-sm">Services</p>
              <p className="text-3xl font-bold text-white mt-1">{serviceCount}</p>
            </div>
            <div className="w-12 h-12 bg-green-900/50 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
          </div>
          <div className="mt-4">
            <span className="badge badge-info">Running</span>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-slate-400 text-sm">Secrets</p>
              <p className="text-3xl font-bold text-white mt-1">
                {environment._count.secrets}
              </p>
            </div>
            <div className="w-12 h-12 bg-yellow-900/50 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
          </div>
          <div className="mt-4">
            <span className="badge badge-success">Encrypted</span>
          </div>
        </div>
      </div>

      {/* Servers List */}
      <div className="card">
        <h2 className="text-lg font-semibold text-white mb-4">Servers</h2>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                <th className="pb-3 font-medium">Name</th>
                <th className="pb-3 font-medium">IP Address</th>
                <th className="pb-3 font-medium">Services</th>
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 font-medium">Last Checked</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {environment.servers.map((server) => (
                <tr key={server.id} className="text-slate-300">
                  <td className="py-3">
                    <Link
                      to={`/servers/${server.id}`}
                      className="text-white hover:text-primary-400"
                    >
                      {server.name}
                    </Link>
                  </td>
                  <td className="py-3 font-mono text-sm">{server.hostname}</td>
                  <td className="py-3">{server.services.length}</td>
                  <td className="py-3">
                    <StatusBadge status={server.status} />
                  </td>
                  <td className="py-3 text-sm text-slate-400">
                    {server.lastCheckedAt
                      ? formatDistanceToNow(new Date(server.lastCheckedAt), {
                          addSuffix: true,
                        })
                      : 'Never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    healthy: 'badge-success',
    unhealthy: 'badge-error',
    running: 'badge-success',
    stopped: 'badge-error',
    unknown: 'badge-warning',
  };

  return <span className={`badge ${styles[status] || 'badge-info'}`}>{status}</span>;
}

import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';
import { getAuditLogs, type AuditLog } from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

const RESOURCE_TYPES = [
  { value: '', label: 'All Types' },
  { value: 'service', label: 'Service' },
  { value: 'server', label: 'Server' },
  { value: 'secret', label: 'Secret' },
  { value: 'environment', label: 'Environment' },
  { value: 'env_template', label: 'Env Template' },
];

const ACTION_COLORS: Record<string, string> = {
  create: 'bg-green-500/20 text-green-400',
  update: 'bg-blue-500/20 text-blue-400',
  delete: 'bg-red-500/20 text-red-400',
  deploy: 'bg-purple-500/20 text-purple-400',
  restart: 'bg-yellow-500/20 text-yellow-400',
  health_check: 'bg-cyan-500/20 text-cyan-400',
  access: 'bg-orange-500/20 text-orange-400',
  webhook_deploy: 'bg-pink-500/20 text-pink-400',
  discover: 'bg-indigo-500/20 text-indigo-400',
  import: 'bg-teal-500/20 text-teal-400',
};

export default function Activity() {
  const { selectedEnvironment } = useAppStore();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [resourceTypeFilter, setResourceTypeFilter] = useState('');
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const limit = 20;

  useEffect(() => {
    setLoading(true);
    getAuditLogs({
      environmentId: selectedEnvironment?.id,
      resourceType: resourceTypeFilter || undefined,
      limit,
      offset: page * limit,
    })
      .then(({ logs, total }) => {
        setLogs(logs);
        setTotal(total);
      })
      .finally(() => setLoading(false));
  }, [selectedEnvironment?.id, resourceTypeFilter, page]);

  const totalPages = Math.ceil(total / limit);

  if (loading && logs.length === 0) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-8"></div>
          <div className="space-y-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 bg-slate-800 rounded-lg"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Track all actions performed in {selectedEnvironment?.name || 'all environments'}
        </p>
        <div className="flex items-center gap-4">
          <select
            value={resourceTypeFilter}
            onChange={(e) => {
              setResourceTypeFilter(e.target.value);
              setPage(0);
            }}
            className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white"
          >
            {RESOURCE_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                <th className="pb-3 font-medium">Time</th>
                <th className="pb-3 font-medium">User</th>
                <th className="pb-3 font-medium">Action</th>
                <th className="pb-3 font-medium">Resource</th>
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-400">
                    No activity logs found
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <>
                    <tr key={log.id} className="text-slate-300">
                      <td className="py-3 text-sm">
                        <span
                          title={new Date(log.createdAt).toLocaleString()}
                          className="text-slate-400"
                        >
                          {formatDistanceToNow(new Date(log.createdAt), {
                            addSuffix: true,
                          })}
                        </span>
                      </td>
                      <td className="py-3">
                        <span className="text-white">
                          {log.user?.email || 'System'}
                        </span>
                      </td>
                      <td className="py-3">
                        <span
                          className={`px-2 py-1 rounded text-xs font-medium ${
                            ACTION_COLORS[log.action] || 'bg-slate-500/20 text-slate-400'
                          }`}
                        >
                          {log.action.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="py-3">
                        <div>
                          <span className="text-xs text-slate-400 uppercase">
                            {log.resourceType.replace('_', ' ')}
                          </span>
                          {log.resourceName && (
                            <span className="ml-2 text-white font-medium">
                              {log.resourceName}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3">
                        {log.success ? (
                          <span className="badge badge-success">Success</span>
                        ) : (
                          <span className="badge badge-error">Failed</span>
                        )}
                      </td>
                      <td className="py-3">
                        {(log.details || log.error) && (
                          <button
                            onClick={() =>
                              setExpandedLog(expandedLog === log.id ? null : log.id)
                            }
                            className="text-slate-400 hover:text-white"
                          >
                            <ChevronIcon
                              className={`w-5 h-5 transition-transform ${
                                expandedLog === log.id ? 'rotate-180' : ''
                              }`}
                            />
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedLog === log.id && (log.details || log.error) && (
                      <tr key={`${log.id}-details`}>
                        <td colSpan={6} className="py-4 px-4 bg-slate-800/50">
                          {log.error && (
                            <div className="mb-2">
                              <span className="text-red-400 font-medium">Error: </span>
                              <span className="text-slate-300">{log.error}</span>
                            </div>
                          )}
                          {log.details && (
                            <pre className="text-xs text-slate-400 overflow-x-auto">
                              {JSON.stringify(JSON.parse(log.details), null, 2)}
                            </pre>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-700">
            <span className="text-sm text-slate-400">
              Showing {page * limit + 1}-{Math.min((page + 1) * limit, total)} of {total}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
                className="px-3 py-1 rounded bg-slate-700 text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-600"
              >
                Previous
              </button>
              <span className="text-slate-400">
                Page {page + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                disabled={page >= totalPages - 1}
                className="px-3 py-1 rounded bg-slate-700 text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-600"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';
import {
  getHealthLogs,
  runHealthChecks,
  type HealthLogsResponse,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';

const timeRanges = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

export default function MonitoringHealth() {
  const {
    selectedEnvironment,
    monitoringTimeRange,
    setMonitoringTimeRange,
    monitoringHealthType,
    setMonitoringHealthType,
    monitoringHealthStatus,
    setMonitoringHealthStatus,
  } = useAppStore();
  const [data, setData] = useState<HealthLogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [page, setPage] = useState(1);
  const limit = 50;

  const fetchData = async () => {
    if (!selectedEnvironment?.id) return;
    setLoading(true);
    try {
      const response = await getHealthLogs(selectedEnvironment.id, {
        ...(monitoringHealthType && { type: monitoringHealthType as 'server' | 'service' | 'container' }),
        ...(monitoringHealthStatus && { status: monitoringHealthStatus as 'success' | 'failure' | 'timeout' }),
        hours: monitoringTimeRange,
        page,
        limit,
      });
      setData(response);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [selectedEnvironment?.id, monitoringHealthType, monitoringHealthStatus, monitoringTimeRange, page]);

  const handleRunAll = async () => {
    if (!selectedEnvironment?.id) return;
    setRunning(true);
    try {
      await runHealthChecks(selectedEnvironment.id, 'all');
      await fetchData();
    } finally {
      setRunning(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
        return 'text-green-400';
      case 'failure':
        return 'text-red-400';
      case 'timeout':
        return 'text-yellow-400';
      default:
        return 'text-slate-400';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return (
          <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
        );
      case 'failure':
        return (
          <svg className="w-4 h-4 text-red-400" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
        );
      case 'timeout':
        return (
          <svg className="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
          </svg>
        );
      default:
        return null;
    }
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <p className="text-slate-400">Select an environment to view health checks</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Health check logs for {selectedEnvironment.name}
        </p>
        <div className="flex gap-2">
          <button
            onClick={handleRunAll}
            disabled={running}
            className="btn btn-primary"
          >
            {running ? 'Running...' : 'Run All'}
          </button>
          <button
            onClick={fetchData}
            disabled={loading}
            className="btn btn-secondary"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      {data && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <SummaryCard
            title="Server SSH"
            summary={data.summary.server}
          />
          <SummaryCard
            title="Service URL"
            summary={data.summary.service}
          />
          <SummaryCard
            title="Container"
            summary={data.summary.container}
          />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <select
          value={monitoringHealthType}
          onChange={(e) => {
            setMonitoringHealthType(e.target.value);
            setPage(1);
          }}
          className="input w-40"
        >
          <option value="">All Types</option>
          <option value="server">Server</option>
          <option value="service">Service</option>
          <option value="container">Container</option>
        </select>

        <select
          value={monitoringHealthStatus}
          onChange={(e) => {
            setMonitoringHealthStatus(e.target.value);
            setPage(1);
          }}
          className="input w-40"
        >
          <option value="">All Status</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="timeout">Timeout</option>
        </select>

        <div className="flex rounded-lg overflow-hidden border border-slate-600">
          {timeRanges.map((range) => (
            <button
              key={range.hours}
              onClick={() => {
                setMonitoringTimeRange(range.hours);
                setPage(1);
              }}
              className={`px-3 py-1.5 text-sm ${
                monitoringTimeRange === range.hours
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      {/* Logs Table */}
      {loading ? (
        <div className="card">
          <div className="animate-pulse space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-10 bg-slate-700 rounded" />
            ))}
          </div>
        </div>
      ) : data && data.logs.length > 0 ? (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                  <th className="pb-3 font-medium">Time</th>
                  <th className="pb-3 font-medium">Resource</th>
                  <th className="pb-3 font-medium">Type</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Duration</th>
                  <th className="pb-3 font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {data.logs.map((log) => (
                  <tr key={log.id} className="text-slate-300">
                    <td className="py-3 text-sm">
                      <span className="text-slate-400" title={format(new Date(log.createdAt), 'PPpp')}>
                        {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                      </span>
                    </td>
                    <td className="py-3">
                      <div>
                        <span className="text-white">{log.resourceName}</span>
                        <span className="text-slate-500 text-xs ml-2 capitalize">{log.resourceType}</span>
                      </div>
                    </td>
                    <td className="py-3 text-sm">
                      <span className="capitalize">{log.checkType.replace('_', ' ')}</span>
                      {log.httpStatus && (
                        <span className="ml-2 text-slate-500">{log.httpStatus}</span>
                      )}
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-1.5">
                        {getStatusIcon(log.status)}
                        <span className={getStatusColor(log.status)}>
                          {log.status}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 text-sm font-mono">
                      {log.durationMs != null ? `${log.durationMs}ms` : '-'}
                    </td>
                    <td className="py-3 text-sm text-red-400 max-w-xs truncate" title={log.errorMessage || undefined}>
                      {log.errorMessage || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-700 pt-4 mt-4">
              <span className="text-sm text-slate-400">
                Showing {(data.page - 1) * limit + 1} to {Math.min(data.page * limit, data.total)} of {data.total} results
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(page - 1)}
                  disabled={page === 1}
                  className="btn btn-secondary px-3 py-1"
                >
                  Previous
                </button>
                <span className="px-3 py-1 text-slate-400">
                  Page {data.page} of {data.totalPages}
                </span>
                <button
                  onClick={() => setPage(page + 1)}
                  disabled={page >= data.totalPages}
                  className="btn btn-secondary px-3 py-1"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="card text-center py-12">
          <p className="text-slate-400">No health check logs found</p>
          <p className="text-slate-500 text-sm mt-1">
            Logs will appear here as health checks run automatically
          </p>
        </div>
      )}
    </div>
  );
}

interface SummaryCardProps {
  title: string;
  summary: { success: number; failure: number; timeout: number };
}

function SummaryCard({ title, summary }: SummaryCardProps) {
  const total = summary.success + summary.failure + summary.timeout;
  const successRate = total > 0 ? (summary.success / total) * 100 : 0;

  return (
    <div className="card">
      <h3 className="text-sm font-medium text-slate-400 mb-2">{title}</h3>
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-2xl font-bold text-white">{summary.success}/{total}</span>
        <span className="text-slate-400 text-sm">passing</span>
      </div>
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-green-500 rounded-full transition-all"
          style={{ width: `${successRate}%` }}
        />
      </div>
      <div className="flex gap-4 mt-2 text-xs">
        <span className="text-green-400">{summary.success} passed</span>
        {summary.failure > 0 && <span className="text-red-400">{summary.failure} failed</span>}
        {summary.timeout > 0 && <span className="text-yellow-400">{summary.timeout} timeout</span>}
      </div>
    </div>
  );
}

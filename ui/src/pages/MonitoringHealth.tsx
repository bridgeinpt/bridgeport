import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getHealthLogs,
  getHealthStatus,
  runHealthChecks,
  testServerSSH,
  checkServiceHealth,
  testDatabaseConnection,
  type HealthLogsResponse,
  type HealthStatusResponse,
  type ResourceHealthStatus,
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
    monitoringHealthTab,
    setMonitoringHealthTab,
    monitoringTimeRange,
    setMonitoringTimeRange,
    monitoringHealthType,
    setMonitoringHealthType,
    monitoringHealthStatus,
    setMonitoringHealthStatus,
  } = useAppStore();

  // Status tab state
  const [statusData, setStatusData] = useState<HealthStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [testingResource, setTestingResource] = useState<string | null>(null);

  // Logs tab state
  const [logsData, setLogsData] = useState<HealthLogsResponse | null>(null);
  const [logsLoading, setLogsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const limit = 50;

  // Shared state
  const [running, setRunning] = useState(false);

  const fetchStatusData = async () => {
    if (!selectedEnvironment?.id) return;
    setStatusLoading(true);
    try {
      const response = await getHealthStatus(selectedEnvironment.id);
      setStatusData(response);
    } finally {
      setStatusLoading(false);
    }
  };

  const fetchLogsData = async () => {
    if (!selectedEnvironment?.id) return;
    setLogsLoading(true);
    try {
      const response = await getHealthLogs(selectedEnvironment.id, {
        ...(monitoringHealthType && { type: monitoringHealthType as 'server' | 'service' | 'container' }),
        ...(monitoringHealthStatus && { status: monitoringHealthStatus as 'success' | 'failure' | 'timeout' }),
        hours: monitoringTimeRange,
        page,
        limit,
      });
      setLogsData(response);
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    if (monitoringHealthTab === 'status') {
      fetchStatusData();
    }
  }, [selectedEnvironment?.id, monitoringHealthTab]);

  useEffect(() => {
    if (monitoringHealthTab === 'logs') {
      fetchLogsData();
    }
  }, [selectedEnvironment?.id, monitoringHealthType, monitoringHealthStatus, monitoringTimeRange, page, monitoringHealthTab]);

  const handleRunAll = async () => {
    if (!selectedEnvironment?.id) return;
    setRunning(true);
    try {
      await runHealthChecks(selectedEnvironment.id, 'all');
      if (monitoringHealthTab === 'status') {
        await fetchStatusData();
      } else {
        await fetchLogsData();
      }
    } finally {
      setRunning(false);
    }
  };

  const handleTestServer = async (serverId: string) => {
    setTestingResource(serverId);
    try {
      await testServerSSH(serverId);
      await fetchStatusData();
    } finally {
      setTestingResource(null);
    }
  };

  const handleTestService = async (serviceId: string) => {
    setTestingResource(serviceId);
    try {
      await checkServiceHealth(serviceId);
      await fetchStatusData();
    } finally {
      setTestingResource(null);
    }
  };

  const handleTestDatabase = async (dbId: string) => {
    if (!selectedEnvironment?.id) return;
    setTestingResource(dbId);
    try {
      await testDatabaseConnection(selectedEnvironment.id, dbId);
      await fetchStatusData();
    } finally {
      setTestingResource(null);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
      case 'healthy':
        return 'text-green-400';
      case 'failure':
      case 'unhealthy':
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
      case 'healthy':
        return (
          <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
        );
      case 'failure':
      case 'unhealthy':
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
      case 'unknown':
        return (
          <svg className="w-4 h-4 text-slate-400" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
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

  // Calculate status counts
  const healthyCounts = {
    servers: statusData?.servers.filter(s => s.status === 'healthy').length ?? 0,
    services: statusData?.services.filter(s => s.status === 'healthy').length ?? 0,
    databases: statusData?.databases?.filter(s => s.status === 'healthy').length ?? 0,
  };
  const unhealthyCounts = {
    servers: statusData?.servers.filter(s => s.status === 'unhealthy').length ?? 0,
    services: statusData?.services.filter(s => s.status === 'unhealthy').length ?? 0,
    databases: statusData?.databases?.filter(s => s.status === 'unhealthy').length ?? 0,
  };
  const unknownCounts = {
    servers: statusData?.servers.filter(s => s.status === 'unknown').length ?? 0,
    services: statusData?.services.filter(s => s.status === 'unknown').length ?? 0,
    databases: statusData?.databases?.filter(s => s.status === 'unknown').length ?? 0,
  };
  const totalResources = (statusData?.servers.length ?? 0) + (statusData?.services.length ?? 0) + (statusData?.databases?.length ?? 0);
  const totalHealthy = healthyCounts.servers + healthyCounts.services + healthyCounts.databases;
  const totalUnhealthy = unhealthyCounts.servers + unhealthyCounts.services + unhealthyCounts.databases;
  const totalUnknown = unknownCounts.servers + unknownCounts.services + unknownCounts.databases;

  // Sort resources: unhealthy first, then healthy, then unknown
  const sortByStatus = (a: ResourceHealthStatus, b: ResourceHealthStatus) => {
    const order = { unhealthy: 0, healthy: 1, unknown: 2 };
    return order[a.status] - order[b.status];
  };

  const sortedServers = [...(statusData?.servers ?? [])].sort(sortByStatus);
  const sortedServices = [...(statusData?.services ?? [])].sort(sortByStatus);
  const sortedDatabases = [...(statusData?.databases ?? [])].sort(sortByStatus);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Health status and check history for {selectedEnvironment.name}
        </p>
        <div className="flex gap-2">
          <button
            onClick={handleRunAll}
            disabled={running}
            className="btn btn-primary"
          >
            {running ? 'Running...' : 'Run All Checks'}
          </button>
          <button
            onClick={() => monitoringHealthTab === 'status' ? fetchStatusData() : fetchLogsData()}
            disabled={statusLoading || logsLoading}
            className="btn btn-secondary"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-6 border-b border-slate-700 mb-6">
        <button
          onClick={() => setMonitoringHealthTab('status')}
          className={`pb-3 text-sm font-medium border-b-2 -mb-px ${
            monitoringHealthTab === 'status'
              ? 'border-brand-600 text-white'
              : 'border-transparent text-slate-400 hover:text-slate-300'
          }`}
        >
          Status
        </button>
        <button
          onClick={() => setMonitoringHealthTab('logs')}
          className={`pb-3 text-sm font-medium border-b-2 -mb-px ${
            monitoringHealthTab === 'logs'
              ? 'border-brand-600 text-white'
              : 'border-transparent text-slate-400 hover:text-slate-300'
          }`}
        >
          Logs
        </button>
      </div>

      {/* Status Tab */}
      {monitoringHealthTab === 'status' && (
        <>
          {/* Quick Stats */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="card">
              <div className="text-2xl font-bold text-white">{totalResources}</div>
              <div className="text-sm text-slate-400">Total Resources</div>
            </div>
            <div className="card">
              <div className="text-2xl font-bold text-green-400">{totalHealthy}</div>
              <div className="text-sm text-slate-400">Healthy</div>
            </div>
            <div className="card">
              <div className="text-2xl font-bold text-red-400">{totalUnhealthy}</div>
              <div className="text-sm text-slate-400">Unhealthy</div>
            </div>
            <div className="card">
              <div className="text-2xl font-bold text-slate-400">{totalUnknown}</div>
              <div className="text-sm text-slate-400">Unknown</div>
            </div>
          </div>

          {statusLoading ? (
            <div className="card">
              <div className="animate-pulse space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-10 bg-slate-700 rounded" />
                ))}
              </div>
            </div>
          ) : (
            <>
              {/* Servers Section */}
              {sortedServers.length > 0 && (
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-white mb-3">
                    Servers
                    <span className="ml-2 text-sm font-normal text-slate-400">
                      ({healthyCounts.servers} healthy, {unhealthyCounts.servers} unhealthy, {unknownCounts.servers} unknown)
                    </span>
                  </h2>
                  <div className="card overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                          <th className="pb-3 font-medium">Name</th>
                          <th className="pb-3 font-medium">Status</th>
                          <th className="pb-3 font-medium">Last Check</th>
                          <th className="pb-3 font-medium">Duration</th>
                          <th className="pb-3 font-medium text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700">
                        {sortedServers.map((server) => (
                          <tr key={server.id} className="text-slate-300">
                            <td className="py-3">
                              <Link
                                to={`/servers/${server.id}`}
                                className="text-white hover:text-primary-400 font-medium"
                              >
                                {server.name}
                              </Link>
                            </td>
                            <td className="py-3">
                              <div className="flex items-center gap-1.5">
                                {getStatusIcon(server.status)}
                                <span className={getStatusColor(server.status)}>
                                  {server.status}
                                </span>
                              </div>
                            </td>
                            <td className="py-3 text-sm text-slate-400">
                              {server.lastCheck ? (
                                <span title={format(new Date(server.lastCheck.timestamp), 'PPpp')}>
                                  {formatDistanceToNow(new Date(server.lastCheck.timestamp), { addSuffix: true })}
                                </span>
                              ) : (
                                'Never'
                              )}
                            </td>
                            <td className="py-3 text-sm font-mono">
                              {server.lastCheck?.durationMs != null ? `${server.lastCheck.durationMs}ms` : '-'}
                            </td>
                            <td className="py-3 text-right">
                              <button
                                onClick={() => handleTestServer(server.id)}
                                disabled={testingResource === server.id}
                                className="btn btn-ghost text-sm"
                              >
                                {testingResource === server.id ? 'Testing...' : 'Test'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Services Section */}
              {sortedServices.length > 0 && (
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-white mb-3">
                    Services
                    <span className="ml-2 text-sm font-normal text-slate-400">
                      ({healthyCounts.services} healthy, {unhealthyCounts.services} unhealthy, {unknownCounts.services} unknown)
                    </span>
                  </h2>
                  <div className="card overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                          <th className="pb-3 font-medium">Name</th>
                          <th className="pb-3 font-medium">Server</th>
                          <th className="pb-3 font-medium">Status</th>
                          <th className="pb-3 font-medium">Last Check</th>
                          <th className="pb-3 font-medium">Duration</th>
                          <th className="pb-3 font-medium text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700">
                        {sortedServices.map((service) => (
                          <tr key={service.id} className="text-slate-300">
                            <td className="py-3">
                              <Link
                                to={`/services/${service.id}`}
                                className="text-white hover:text-primary-400 font-medium"
                              >
                                {service.name}
                              </Link>
                            </td>
                            <td className="py-3 text-sm text-slate-400">
                              {service.serverName}
                            </td>
                            <td className="py-3">
                              <div className="flex items-center gap-1.5">
                                {getStatusIcon(service.status)}
                                <span className={getStatusColor(service.status)}>
                                  {service.status}
                                </span>
                              </div>
                            </td>
                            <td className="py-3 text-sm text-slate-400">
                              {service.lastCheck ? (
                                <span title={format(new Date(service.lastCheck.timestamp), 'PPpp')}>
                                  {formatDistanceToNow(new Date(service.lastCheck.timestamp), { addSuffix: true })}
                                </span>
                              ) : (
                                'Never'
                              )}
                            </td>
                            <td className="py-3 text-sm font-mono">
                              {service.lastCheck?.durationMs != null ? `${service.lastCheck.durationMs}ms` : '-'}
                            </td>
                            <td className="py-3 text-right">
                              <button
                                onClick={() => handleTestService(service.id)}
                                disabled={testingResource === service.id}
                                className="btn btn-ghost text-sm"
                              >
                                {testingResource === service.id ? 'Testing...' : 'Test'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Databases Section */}
              {sortedDatabases.length > 0 && (
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-white mb-3">
                    Databases
                    <span className="ml-2 text-sm font-normal text-slate-400">
                      ({healthyCounts.databases} healthy, {unhealthyCounts.databases} unhealthy, {unknownCounts.databases} unknown)
                    </span>
                  </h2>
                  <div className="card overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                          <th className="pb-3 font-medium">Name</th>
                          <th className="pb-3 font-medium">Type</th>
                          <th className="pb-3 font-medium">Server</th>
                          <th className="pb-3 font-medium">Status</th>
                          <th className="pb-3 font-medium">Last Collection</th>
                          <th className="pb-3 font-medium">Error</th>
                          <th className="pb-3 font-medium text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700">
                        {sortedDatabases.map((db) => (
                          <tr key={db.id} className="text-slate-300">
                            <td className="py-3">
                              <Link
                                to={`/databases/${db.id}`}
                                className="text-white hover:text-primary-400 font-medium"
                              >
                                {db.name}
                              </Link>
                            </td>
                            <td className="py-3 text-sm">
                              <span className="badge bg-slate-700 text-slate-300 text-xs">{db.dbType}</span>
                            </td>
                            <td className="py-3 text-sm text-slate-400">
                              {db.serverName || '-'}
                            </td>
                            <td className="py-3">
                              <div className="flex items-center gap-1.5">
                                {getStatusIcon(db.status)}
                                <span className={getStatusColor(db.status)}>
                                  {db.status}
                                </span>
                              </div>
                            </td>
                            <td className="py-3 text-sm text-slate-400">
                              {db.lastCheck ? (
                                <span title={format(new Date(db.lastCheck.timestamp), 'PPpp')}>
                                  {formatDistanceToNow(new Date(db.lastCheck.timestamp), { addSuffix: true })}
                                </span>
                              ) : (
                                'Never'
                              )}
                            </td>
                            <td className="py-3 text-sm text-red-400 max-w-xs truncate" title={db.lastCheck?.errorMessage || undefined}>
                              {db.lastCheck?.errorMessage || '-'}
                            </td>
                            <td className="py-3 text-right">
                              <button
                                onClick={() => handleTestDatabase(db.id)}
                                disabled={testingResource === db.id}
                                className="btn btn-ghost text-sm"
                              >
                                {testingResource === db.id ? 'Testing...' : 'Test'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Empty State */}
              {sortedServers.length === 0 && sortedServices.length === 0 && sortedDatabases.length === 0 && (
                <div className="card text-center py-12">
                  <p className="text-slate-400">No resources found in this environment</p>
                  <p className="text-slate-500 text-sm mt-1">
                    Add servers, services, or databases to monitor their health
                  </p>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Logs Tab */}
      {monitoringHealthTab === 'logs' && (
        <>
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
          {logsLoading ? (
            <div className="card">
              <div className="animate-pulse space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-10 bg-slate-700 rounded" />
                ))}
              </div>
            </div>
          ) : logsData && logsData.logs.length > 0 ? (
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
                    {logsData.logs.map((log) => (
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
              {logsData.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-slate-700 pt-4 mt-4">
                  <span className="text-sm text-slate-400">
                    Showing {(logsData.page - 1) * limit + 1} to {Math.min(logsData.page * limit, logsData.total)} of {logsData.total} results
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
                      Page {logsData.page} of {logsData.totalPages}
                    </span>
                    <button
                      onClick={() => setPage(page + 1)}
                      disabled={page >= logsData.totalPages}
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
        </>
      )}
    </div>
  );
}

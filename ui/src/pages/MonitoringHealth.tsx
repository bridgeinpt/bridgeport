import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, CircleX, Clock, CircleHelp } from 'lucide-react';
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
import { ServerIcon, CubeIcon, DatabaseIcon } from '../components/Icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/table-skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import StatCard from '../components/monitoring/StatCard';
import TimeRangeSelector from '../components/monitoring/TimeRangeSelector';
import AutoRefreshToggle from '../components/monitoring/AutoRefreshToggle';

const HEALTH_TYPE_ALL = 'all';
const HEALTH_STATUS_ALL = 'all';

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
    autoRefreshEnabled,
    setAutoRefreshEnabled,
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
  const [refreshing, setRefreshing] = useState(false);

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

  // Auto-refresh — mirror MonitoringServers: a 30s interval re-fetches the
  // active tab silently (no skeleton flash) while the toggle is enabled.
  // A ref holds the latest fetchers so the interval doesn't churn on each
  // filter/tab change.
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  refreshRef.current = async () => {
    setRefreshing(true);
    try {
      if (monitoringHealthTab === 'status') {
        const response = await getHealthStatus(selectedEnvironment!.id);
        setStatusData(response);
      } else {
        const response = await getHealthLogs(selectedEnvironment!.id, {
          ...(monitoringHealthType && { type: monitoringHealthType as 'server' | 'service' | 'container' }),
          ...(monitoringHealthStatus && { status: monitoringHealthStatus as 'success' | 'failure' | 'timeout' }),
          hours: monitoringTimeRange,
          page,
          limit,
        });
        setLogsData(response);
      }
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!autoRefreshEnabled || !selectedEnvironment?.id) return;
    const id = setInterval(() => {
      void refreshRef.current();
    }, 30000);
    return () => clearInterval(id);
  }, [autoRefreshEnabled, selectedEnvironment?.id]);

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

  const handleRefresh = () => {
    if (monitoringHealthTab === 'status') {
      void fetchStatusData();
    } else {
      void fetchLogsData();
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

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
      case 'healthy':
        return <CircleCheck className="w-4 h-4 text-success" />;
      case 'failure':
      case 'unhealthy':
        return <CircleX className="w-4 h-4 text-destructive" />;
      case 'timeout':
        return <Clock className="w-4 h-4 text-warning" />;
      case 'unknown':
        return <CircleHelp className="w-4 h-4 text-muted-foreground" />;
      default:
        return null;
    }
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Select an environment to view health checks</p>
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
      <div className="flex items-center justify-end gap-3 mb-5">
        <Button onClick={handleRunAll} disabled={running}>
          {running ? 'Running...' : 'Run All Checks'}
        </Button>
        <AutoRefreshToggle
          enabled={autoRefreshEnabled}
          onChange={setAutoRefreshEnabled}
          onRefresh={handleRefresh}
          refreshing={refreshing || statusLoading || logsLoading}
        />
      </div>

      {/* Tab Navigation */}
      <Tabs
        value={monitoringHealthTab}
        onValueChange={(v) => setMonitoringHealthTab(v as 'status' | 'logs')}
        className="mb-6"
      >
        <TabsList>
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Status Tab */}
      {monitoringHealthTab === 'status' && (
        <>
          {/* Quick Stats */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <StatCard label="Total Resources" value={totalResources} color="slate" />
            <StatCard label="Healthy" value={totalHealthy} color="green" />
            <StatCard label="Unhealthy" value={totalUnhealthy} color="red" />
            <StatCard label="Unknown" value={totalUnknown} color="slate" />
          </div>

          {statusLoading ? (
            <Card className="py-0 overflow-hidden">
              <TableSkeleton rows={5} columns={5} />
            </Card>
          ) : (
            <>
              {/* Servers Section */}
              {sortedServers.length > 0 && (
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                    <ServerIcon className="w-5 h-5 text-info" />
                    Servers
                    <span className="text-sm font-normal text-muted-foreground">
                      ({healthyCounts.servers} healthy, {unhealthyCounts.servers} unhealthy, {unknownCounts.servers} unknown)
                    </span>
                  </h2>
                  <Card className="py-0 overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Last Check</TableHead>
                          <TableHead>Duration</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedServers.map((server) => (
                          <TableRow key={server.id}>
                            <TableCell>
                              <Link
                                to={`/servers/${server.id}`}
                                className="text-foreground hover:text-primary font-medium"
                              >
                                {server.name}
                              </Link>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                {getStatusIcon(server.status)}
                                <StatusBadge kind="health" value={server.status} />
                              </div>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {server.lastCheck ? (
                                <span title={format(new Date(server.lastCheck.timestamp), 'PPpp')}>
                                  {formatDistanceToNow(new Date(server.lastCheck.timestamp), { addSuffix: true })}
                                </span>
                              ) : (
                                'Never'
                              )}
                            </TableCell>
                            <TableCell className="text-sm font-mono">
                              {server.lastCheck?.durationMs != null ? `${server.lastCheck.durationMs}ms` : '-'}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleTestServer(server.id)}
                                disabled={testingResource === server.id}
                              >
                                {testingResource === server.id ? 'Testing...' : 'Test'}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                </div>
              )}

              {/* Services Section */}
              {sortedServices.length > 0 && (
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                    <CubeIcon className="w-5 h-5 text-success" />
                    Services
                    <span className="text-sm font-normal text-muted-foreground">
                      ({healthyCounts.services} healthy, {unhealthyCounts.services} unhealthy, {unknownCounts.services} unknown)
                    </span>
                  </h2>
                  <Card className="py-0 overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Server</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Last Check</TableHead>
                          <TableHead>Duration</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedServices.map((service) => (
                          <TableRow key={service.id}>
                            <TableCell>
                              <Link
                                to={`/services/${service.id}`}
                                className="text-foreground hover:text-primary font-medium"
                              >
                                {service.name}
                              </Link>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {service.serverName}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                {getStatusIcon(service.status)}
                                <StatusBadge kind="health" value={service.status} />
                              </div>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {service.lastCheck ? (
                                <span title={format(new Date(service.lastCheck.timestamp), 'PPpp')}>
                                  {formatDistanceToNow(new Date(service.lastCheck.timestamp), { addSuffix: true })}
                                </span>
                              ) : (
                                'Never'
                              )}
                            </TableCell>
                            <TableCell className="text-sm font-mono">
                              {service.lastCheck?.durationMs != null ? `${service.lastCheck.durationMs}ms` : '-'}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleTestService(service.id)}
                                disabled={testingResource === service.id}
                              >
                                {testingResource === service.id ? 'Testing...' : 'Test'}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                </div>
              )}

              {/* Databases Section */}
              {sortedDatabases.length > 0 && (
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                    <DatabaseIcon className="w-5 h-5 text-purple-400" />
                    Databases
                    <span className="text-sm font-normal text-muted-foreground">
                      ({healthyCounts.databases} healthy, {unhealthyCounts.databases} unhealthy, {unknownCounts.databases} unknown)
                    </span>
                  </h2>
                  <Card className="py-0 overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Server</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Last Collection</TableHead>
                          <TableHead>Error</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedDatabases.map((db) => (
                          <TableRow key={db.id}>
                            <TableCell>
                              <Link
                                to={`/databases/${db.id}`}
                                className="text-foreground hover:text-primary font-medium"
                              >
                                {db.name}
                              </Link>
                            </TableCell>
                            <TableCell className="text-sm">
                              <Badge variant="neutral" className="text-xs">{db.dbType}</Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {db.serverName || '-'}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                {getStatusIcon(db.status)}
                                <StatusBadge kind="health" value={db.status} />
                              </div>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {db.lastCheck ? (
                                <span title={format(new Date(db.lastCheck.timestamp), 'PPpp')}>
                                  {formatDistanceToNow(new Date(db.lastCheck.timestamp), { addSuffix: true })}
                                </span>
                              ) : (
                                'Never'
                              )}
                            </TableCell>
                            <TableCell className="text-sm text-destructive max-w-xs truncate" title={db.lastCheck?.errorMessage || undefined}>
                              {db.lastCheck?.errorMessage || '-'}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleTestDatabase(db.id)}
                                disabled={testingResource === db.id}
                              >
                                {testingResource === db.id ? 'Testing...' : 'Test'}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                </div>
              )}

              {/* Empty State */}
              {sortedServers.length === 0 && sortedServices.length === 0 && sortedDatabases.length === 0 && (
                <EmptyState
                  message="No resources found in this environment"
                  description="Add servers, services, or databases to monitor their health"
                />
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
            <Select
              value={monitoringHealthType || HEALTH_TYPE_ALL}
              onValueChange={(value) => {
                setMonitoringHealthType(value === HEALTH_TYPE_ALL ? '' : value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={HEALTH_TYPE_ALL}>All Types</SelectItem>
                <SelectItem value="server">Server</SelectItem>
                <SelectItem value="service">Service</SelectItem>
                <SelectItem value="container">Container</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={monitoringHealthStatus || HEALTH_STATUS_ALL}
              onValueChange={(value) => {
                setMonitoringHealthStatus(value === HEALTH_STATUS_ALL ? '' : value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={HEALTH_STATUS_ALL}>All Status</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="failure">Failure</SelectItem>
                <SelectItem value="timeout">Timeout</SelectItem>
              </SelectContent>
            </Select>

            <TimeRangeSelector
              value={monitoringTimeRange}
              onChange={(hours) => {
                setMonitoringTimeRange(hours);
                setPage(1);
              }}
            />
          </div>

          {/* Logs Table */}
          {logsLoading ? (
            <Card className="py-0 overflow-hidden">
              <TableSkeleton rows={5} columns={6} />
            </Card>
          ) : logsData && logsData.logs.length > 0 ? (
            <Card className="gap-0 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Resource</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logsData.logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-sm">
                        <span className="text-muted-foreground" title={format(new Date(log.createdAt), 'PPpp')}>
                          {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div>
                          <span className="text-foreground">{log.resourceName}</span>
                          <span className="text-muted-foreground text-xs ml-2 capitalize">{log.resourceType}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="capitalize">{log.checkType.replace('_', ' ')}</span>
                        {log.httpStatus && (
                          <span className="ml-2 text-muted-foreground">{log.httpStatus}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {getStatusIcon(log.status)}
                          <StatusBadge kind="health" value={log.status} />
                        </div>
                      </TableCell>
                      <TableCell className="text-sm font-mono">
                        {log.durationMs != null ? `${log.durationMs}ms` : '-'}
                      </TableCell>
                      <TableCell className="text-sm text-destructive max-w-xs truncate" title={log.errorMessage || undefined}>
                        {log.errorMessage || '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {logsData.totalPages > 1 && (
                <div className="flex items-center justify-between border-t px-4 py-4">
                  <span className="text-sm text-muted-foreground">
                    Showing {(logsData.page - 1) * limit + 1} to {Math.min(logsData.page * limit, logsData.total)} of {logsData.total} results
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setPage(page - 1)}
                      disabled={page === 1}
                    >
                      Previous
                    </Button>
                    <span className="px-3 py-1 text-sm text-muted-foreground">
                      Page {logsData.page} of {logsData.totalPages}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setPage(page + 1)}
                      disabled={page >= logsData.totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          ) : (
            <EmptyState
              message="No health check logs found"
              description="Logs will appear here as health checks run automatically"
            />
          )}
        </>
      )}
    </div>
  );
}

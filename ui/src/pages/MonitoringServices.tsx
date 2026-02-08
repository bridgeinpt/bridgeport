import { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getServiceMetricsHistory,
  getEnvironmentMetricsSummary,
  type ServiceMetricsHistoryItem,
  type MetricsSummaryServer,
  type ServiceMetrics,
} from '../lib/api';
import { format } from 'date-fns';
import ChartCard from '../components/monitoring/ChartCard';
import TimeRangeSelector from '../components/monitoring/TimeRangeSelector';
import AutoRefreshToggle from '../components/monitoring/AutoRefreshToggle';

export default function MonitoringServices() {
  const {
    selectedEnvironment,
    monitoringTimeRange,
    setMonitoringTimeRange,
    autoRefreshEnabled,
    setAutoRefreshEnabled,
    monitoringServiceFilter,
    setMonitoringServiceFilter,
  } = useAppStore();

  const [servers, setServers] = useState<MetricsSummaryServer[]>([]);
  const [serviceMetricsHistory, setServiceMetricsHistory] = useState<ServiceMetricsHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async (isRefresh = false) => {
    if (!selectedEnvironment?.id) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const [summaryRes, serviceRes] = await Promise.all([
        getEnvironmentMetricsSummary(selectedEnvironment.id),
        getServiceMetricsHistory(selectedEnvironment.id, monitoringTimeRange),
      ]);
      setServers(summaryRes.servers);
      setServiceMetricsHistory(serviceRes.services);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [selectedEnvironment?.id, monitoringTimeRange]);

  // Auto-refresh every 30 seconds if enabled
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const interval = setInterval(() => {
      fetchData(true);
    }, 30000);
    return () => clearInterval(interval);
  }, [selectedEnvironment?.id, monitoringTimeRange, autoRefreshEnabled]);

  // All service names for the filter (from history, sorted)
  const allServices = useMemo(() => {
    return serviceMetricsHistory
      .map((s) => ({ id: s.id, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [serviceMetricsHistory]);

  // Filter by service ID
  const filterSet = useMemo(() => new Set(monitoringServiceFilter), [monitoringServiceFilter]);

  const filteredServers = useMemo(() => {
    if (filterSet.size === 0) return servers;
    // Only include servers that have at least one selected service
    const matchingServerIds = new Set(
      serviceMetricsHistory.filter((s) => filterSet.has(s.id)).map((s) => s.serverId)
    );
    return servers.filter((s) => matchingServerIds.has(s.id));
  }, [servers, filterSet, serviceMetricsHistory]);

  const filteredServiceMetricsHistory = useMemo(() => {
    if (filterSet.size === 0) return serviceMetricsHistory;
    return serviceMetricsHistory.filter((s) => filterSet.has(s.id));
  }, [serviceMetricsHistory, filterSet]);

  const handleFilterToggle = useCallback(
    (id: string) => {
      const newFilter = monitoringServiceFilter.includes(id)
        ? monitoringServiceFilter.filter((i) => i !== id)
        : [...monitoringServiceFilter, id];
      setMonitoringServiceFilter(newFilter);
    },
    [monitoringServiceFilter, setMonitoringServiceFilter]
  );

  // Prepare chart data for service metrics
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prepareServiceChartData = (metric: 'cpu' | 'memory' | 'networkRx' | 'networkTx'): any[] => {
    const timeMap = new Map<string, { time: string; [key: string]: string | number | null }>();

    filteredServiceMetricsHistory.forEach((service) => {
      service.data.forEach((point) => {
        if (!timeMap.has(point.time)) {
          timeMap.set(point.time, { time: point.time });
        }
        const entry = timeMap.get(point.time)!;
        if (metric === 'cpu') entry[service.name] = point.cpu ?? null;
        else if (metric === 'memory') entry[service.name] = point.memory ?? null;
        else if (metric === 'networkRx') entry[service.name] = point.networkRx ?? null;
        else if (metric === 'networkTx') entry[service.name] = point.networkTx ?? null;
      });
    });

    return Array.from(timeMap.values()).sort((a, b) =>
      a.time.localeCompare(b.time)
    );
  };

  const formatTime = (time: string) => {
    const date = new Date(time);
    if (monitoringTimeRange <= 24) {
      return format(date, 'HH:mm');
    } else {
      return format(date, 'MMM d HH:mm');
    }
  };

  // Collect all services with metrics for the table (using filtered servers)
  const servicesWithMetrics = useMemo(() => {
    const services: Array<{
      id: string;
      name: string;
      serverName: string;
      serverId: string;
      metrics: ServiceMetrics;
    }> = [];

    filteredServers.forEach((server) => {
      server.services.forEach((service) => {
        if (service.latestMetrics) {
          services.push({
            id: service.id,
            name: service.name,
            serverName: server.name,
            serverId: server.id,
            metrics: service.latestMetrics,
          });
        }
      });
    });

    // Sort by CPU usage descending
    return [...services].sort((a, b) => (b.metrics.cpuPercent || 0) - (a.metrics.cpuPercent || 0));
  }, [filteredServers]);

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-8"></div>
          <div className="grid grid-cols-2 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-64 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const serviceNames = filteredServiceMetricsHistory.map((s) => s.name);

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-5">
        <AutoRefreshToggle
          enabled={autoRefreshEnabled}
          onChange={setAutoRefreshEnabled}
          onRefresh={() => fetchData(true)}
          refreshing={refreshing}
        />
      </div>

      {/* Time Range and Tag Filter */}
      <div className="flex items-center flex-wrap gap-4 mb-6">
        <TimeRangeSelector
          value={monitoringTimeRange}
          onChange={setMonitoringTimeRange}
        />

        {allServices.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Services:</span>
            <div className="flex flex-wrap gap-1">
              {allServices.map((service) => (
                <button
                  key={service.id}
                  onClick={() => handleFilterToggle(service.id)}
                  className={`px-2 py-1 text-xs rounded-full transition-colors ${
                    filterSet.has(service.id)
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {service.name}
                </button>
              ))}
              {filterSet.size > 0 && (
                <button
                  onClick={() => setMonitoringServiceFilter([])}
                  className="px-2 py-1 text-xs rounded-full bg-slate-800 text-slate-400 hover:bg-slate-700"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Service Charts and Table */}
      {filteredServiceMetricsHistory.length > 0 && filteredServiceMetricsHistory.some((s) => s.data.length > 0) ? (
        <>
          <div className="grid grid-cols-2 gap-6 mb-8">
            <ChartCard title="CPU Usage" data={prepareServiceChartData('cpu')} names={serviceNames} formatTime={formatTime} unit="%" domain={[0, 'auto']} />
            <ChartCard title="Memory Usage" data={prepareServiceChartData('memory')} names={serviceNames} formatTime={formatTime} unit=" MB" domain={[0, 'auto']} />
            <ChartCard title="Network RX" data={prepareServiceChartData('networkRx')} names={serviceNames} formatTime={formatTime} unit=" MB" domain={[0, 'auto']} />
            <ChartCard title="Network TX" data={prepareServiceChartData('networkTx')} names={serviceNames} formatTime={formatTime} unit=" MB" domain={[0, 'auto']} />
          </div>

          {/* Services Table */}
          {servicesWithMetrics.length > 0 && (
            <div className="card">
              <h2 className="text-lg font-semibold text-white mb-4">
                Service Resource Usage
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
                      <th className="pb-3 font-medium">Service</th>
                      <th className="pb-3 font-medium">Server</th>
                      <th className="pb-3 font-medium">CPU</th>
                      <th className="pb-3 font-medium">Memory</th>
                      <th className="pb-3 font-medium">Network I/O</th>
                      <th className="pb-3 font-medium">Restarts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {servicesWithMetrics.map((service) => (
                      <tr key={service.id} className="text-slate-300">
                        <td className="py-3">
                          <Link
                            to={`/services/${service.id}`}
                            className="text-white hover:text-brand-400"
                          >
                            {service.name}
                          </Link>
                        </td>
                        <td className="py-3">
                          <Link
                            to={`/servers/${service.serverId}`}
                            className="hover:text-brand-400"
                          >
                            {service.serverName}
                          </Link>
                        </td>
                        <td className="py-3">
                          <span
                            className={
                              (service.metrics.cpuPercent || 0) > 80 ? 'text-red-400' : ''
                            }
                          >
                            {service.metrics.cpuPercent?.toFixed(1) ?? '-'}%
                          </span>
                        </td>
                        <td className="py-3">
                          {service.metrics.memoryUsedMb ? (
                            <span>
                              {service.metrics.memoryUsedMb.toFixed(0)}MB
                              {service.metrics.memoryLimitMb && (
                                <span className="text-slate-500">
                                  {' '}
                                  / {service.metrics.memoryLimitMb.toFixed(0)}MB
                                </span>
                              )}
                            </span>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td className="py-3 text-sm font-mono">
                          {service.metrics.networkRxMb || service.metrics.networkTxMb ? (
                            <span>
                              <span className="text-green-400">
                                {service.metrics.networkRxMb?.toFixed(1) ?? '0'}
                              </span>
                              /
                              <span className="text-blue-400">
                                {service.metrics.networkTxMb?.toFixed(1) ?? '0'}
                              </span>
                              MB
                            </span>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td className="py-3">
                          {service.metrics.restartCount != null ? (
                            <span
                              className={service.metrics.restartCount > 0 ? 'text-yellow-400' : ''}
                            >
                              {service.metrics.restartCount}
                            </span>
                          ) : (
                            '-'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="card text-center py-12">
          <p className="text-slate-400 mb-2">No service metrics available</p>
          <p className="text-slate-500 text-sm">
            Deploy a monitoring agent to collect service metrics.
          </p>
          <Link to="/monitoring/agents#agents" className="btn btn-primary mt-4">
            Configure Agents
          </Link>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getEnvironmentMetricsSummary,
  getMetricsHistory,
  getModuleSettings,
  type MetricsSummaryServer,
  type MetricsHistoryServer,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';
import ChartCard from '../components/monitoring/ChartCard';
import MetricGauge from '../components/monitoring/MetricGauge';
import TimeRangeSelector from '../components/monitoring/TimeRangeSelector';
import AutoRefreshToggle from '../components/monitoring/AutoRefreshToggle';

export default function MonitoringServers() {
  const {
    selectedEnvironment,
    monitoringTimeRange,
    setMonitoringTimeRange,
    autoRefreshEnabled,
    setAutoRefreshEnabled,
    monitoringServerFilter,
    setMonitoringServerFilter,
  } = useAppStore();

  const [servers, setServers] = useState<MetricsSummaryServer[]>([]);
  const [metricsHistory, setMetricsHistory] = useState<MetricsHistoryServer[]>([]);
  const [schedulerConfig, setSchedulerConfig] = useState<Record<string, unknown> | null>(null);
  const [disabledMetricsExpanded, setDisabledMetricsExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async (isRefresh = false) => {
    if (!selectedEnvironment?.id) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const [summaryRes, historyRes, configRes] = await Promise.all([
        getEnvironmentMetricsSummary(selectedEnvironment.id),
        getMetricsHistory(selectedEnvironment.id, monitoringTimeRange),
        getModuleSettings(selectedEnvironment.id, 'monitoring'),
      ]);
      setServers(summaryRes.servers);
      setMetricsHistory(historyRes.servers);
      setSchedulerConfig(configRes.settings);
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

  // Filter by server ID
  const filterSet = useMemo(() => new Set(monitoringServerFilter), [monitoringServerFilter]);

  const filteredServers = useMemo(() => {
    if (filterSet.size === 0) return servers;
    return servers.filter((s) => filterSet.has(s.id));
  }, [servers, filterSet]);

  const filteredMetricsHistory = useMemo(() => {
    if (filterSet.size === 0) return metricsHistory;
    return metricsHistory.filter((s) => filterSet.has(s.id));
  }, [metricsHistory, filterSet]);

  const handleFilterToggle = useCallback(
    (id: string) => {
      const newFilter = monitoringServerFilter.includes(id)
        ? monitoringServerFilter.filter((i) => i !== id)
        : [...monitoringServerFilter, id];
      setMonitoringServerFilter(newFilter);
    },
    [monitoringServerFilter, setMonitoringServerFilter]
  );

  // Prepare chart data for server metrics - combine all servers into single timeline
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prepareServerChartData = (metric: 'cpu' | 'memory' | 'disk' | 'load' | 'swap' | 'tcp'): any[] => {
    const timeMap = new Map<string, { time: string; [key: string]: string | number | null }>();

    filteredMetricsHistory.forEach((server) => {
      server.data.forEach((point) => {
        if (!timeMap.has(point.time)) {
          timeMap.set(point.time, { time: point.time });
        }
        const entry = timeMap.get(point.time)!;
        if (metric === 'cpu') entry[server.name] = point.cpu ?? null;
        else if (metric === 'memory') entry[server.name] = point.memory ?? null;
        else if (metric === 'disk') entry[server.name] = point.disk ?? null;
        else if (metric === 'load') entry[server.name] = point.load1 ?? null;
        else if (metric === 'swap') entry[server.name] = point.swap ?? null;
        else if (metric === 'tcp') entry[server.name] = point.tcpTotal ?? null;
      });
    });

    return Array.from(timeMap.values()).sort((a, b) =>
      a.time.localeCompare(b.time)
    );
  };

  // Memoize chart data per metric to avoid recomputing on every render
  const cpuChartData = useMemo(() => prepareServerChartData('cpu'), [filteredMetricsHistory]);
  const memoryChartData = useMemo(() => prepareServerChartData('memory'), [filteredMetricsHistory]);
  const swapChartData = useMemo(() => prepareServerChartData('swap'), [filteredMetricsHistory]);
  const diskChartData = useMemo(() => prepareServerChartData('disk'), [filteredMetricsHistory]);
  const loadChartData = useMemo(() => prepareServerChartData('load'), [filteredMetricsHistory]);
  const tcpChartData = useMemo(() => prepareServerChartData('tcp'), [filteredMetricsHistory]);

  const formatTime = (time: string) => {
    const date = new Date(time);
    if (monitoringTimeRange <= 24) {
      return format(date, 'HH:mm');
    } else {
      return format(date, 'MMM d HH:mm');
    }
  };

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

  const serversWithMetrics = filteredServers.filter((s) => s.latestMetrics);
  const serverNames = filteredMetricsHistory.map((s) => s.name);

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

        {servers.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Servers:</span>
            <div className="flex flex-wrap gap-1">
              {servers.map((server) => (
                <button
                  key={server.id}
                  onClick={() => handleFilterToggle(server.id)}
                  className={`px-2 py-1 text-xs rounded-full transition-colors ${
                    filterSet.has(server.id)
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {server.name}
                </button>
              ))}
              {filterSet.size > 0 && (
                <button
                  onClick={() => setMonitoringServerFilter([])}
                  className="px-2 py-1 text-xs rounded-full bg-slate-800 text-slate-400 hover:bg-slate-700"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Server Charts */}
      {filteredMetricsHistory.length > 0 && filteredMetricsHistory.some((s) => s.data.length > 0) ? (
        <div className="grid grid-cols-2 gap-6 mb-8">
          {(schedulerConfig?.collectCpu ?? true) && (
            <ChartCard title="CPU Usage" data={cpuChartData} names={serverNames} formatTime={formatTime} unit="%" domain={[0, 100]} />
          )}
          {(schedulerConfig?.collectMemory ?? true) && (
            <ChartCard title="Memory Usage" data={memoryChartData} names={serverNames} formatTime={formatTime} unit="%" domain={[0, 100]} />
          )}
          {(schedulerConfig?.collectSwap ?? true) && (
            <ChartCard title="Swap Usage" data={swapChartData} names={serverNames} formatTime={formatTime} unit="%" domain={[0, 100]} />
          )}
          {(schedulerConfig?.collectDisk ?? true) && (
            <ChartCard title="Disk Usage" data={diskChartData} names={serverNames} formatTime={formatTime} unit="%" domain={[0, 100]} />
          )}
          {(schedulerConfig?.collectLoad ?? true) && (
            <ChartCard title="Load Average" data={loadChartData} names={serverNames} formatTime={formatTime} domain={[0, 'auto']} />
          )}
          {(schedulerConfig?.collectTcp ?? true) && (
            <ChartCard title="TCP Connections" data={tcpChartData} names={serverNames} formatTime={formatTime} domain={[0, 'auto']} />
          )}
        </div>
      ) : (
        <div className="card text-center py-8 mb-8">
          <p className="text-slate-400">No historical metrics data available</p>
          <p className="text-slate-500 text-sm mt-1">
            Metrics will appear here as they are collected
          </p>
        </div>
      )}

      {/* Current Server Metrics */}
      {serversWithMetrics.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-4">Current Server Metrics</h2>
          <div className="space-y-4">
            {serversWithMetrics.map((server) => (
              <div key={server.id} className="card">
                <div className="flex items-center justify-between mb-4">
                  <Link
                    to={`/servers/${server.id}`}
                    className="text-lg font-semibold text-white hover:text-brand-400"
                  >
                    {server.name}
                  </Link>
                  <span className="text-xs text-slate-500">
                    {server.latestMetrics &&
                      formatDistanceToNow(new Date(server.latestMetrics.collectedAt), {
                        addSuffix: true,
                      })}
                  </span>
                </div>

                {/* Primary metrics row */}
                <div className="grid grid-cols-4 gap-4 mb-4">
                  {(schedulerConfig?.collectCpu ?? true) && (
                    <MetricGauge
                      label="CPU"
                      value={server.latestMetrics?.cpuPercent ?? undefined}
                      max={100}
                      unit="%"
                      color="primary"
                    />
                  )}
                  {(schedulerConfig?.collectMemory ?? true) && (
                    <MetricGauge
                      label="Memory"
                      value={
                        server.latestMetrics?.memoryTotalMb
                          ? ((server.latestMetrics.memoryUsedMb ?? 0) /
                              server.latestMetrics.memoryTotalMb) *
                            100
                          : undefined
                      }
                      displayValue={
                        server.latestMetrics?.memoryUsedMb != null && server.latestMetrics?.memoryTotalMb
                          ? `${(server.latestMetrics.memoryUsedMb / 1024).toFixed(1)}/${(server.latestMetrics.memoryTotalMb / 1024).toFixed(0)}GB`
                          : undefined
                      }
                      max={100}
                      unit="%"
                      color="green"
                    />
                  )}
                  {(schedulerConfig?.collectDisk ?? true) && (
                    <MetricGauge
                      label="Disk"
                      value={
                        server.latestMetrics?.diskTotalGb
                          ? ((server.latestMetrics.diskUsedGb ?? 0) /
                              server.latestMetrics.diskTotalGb) *
                            100
                          : undefined
                      }
                      displayValue={
                        server.latestMetrics?.diskUsedGb != null && server.latestMetrics?.diskTotalGb
                          ? `${server.latestMetrics.diskUsedGb.toFixed(0)}/${server.latestMetrics.diskTotalGb.toFixed(0)}GB`
                          : undefined
                      }
                      max={100}
                      unit="%"
                      color="yellow"
                    />
                  )}
                  {(schedulerConfig?.collectLoad ?? true) && (
                    <MetricGauge
                      label="Load"
                      value={server.latestMetrics?.loadAvg1 ?? undefined}
                      max={4}
                      displayValue={server.latestMetrics?.loadAvg1?.toFixed(2) ?? undefined}
                      color="purple"
                    />
                  )}
                </div>

                {/* Additional metrics row */}
                <div className="grid grid-cols-4 gap-4">
                  {(schedulerConfig?.collectSwap ?? true) && (
                    <MetricGauge
                      label="Swap"
                      value={
                        server.latestMetrics?.swapTotalMb && server.latestMetrics.swapTotalMb > 0
                          ? ((server.latestMetrics.swapUsedMb ?? 0) /
                              server.latestMetrics.swapTotalMb) *
                            100
                          : 0
                      }
                      displayValue={
                        server.latestMetrics?.swapUsedMb != null && server.latestMetrics?.swapTotalMb
                          ? server.latestMetrics.swapTotalMb > 0
                            ? `${(server.latestMetrics.swapUsedMb / 1024).toFixed(1)}/${(server.latestMetrics.swapTotalMb / 1024).toFixed(0)}GB`
                            : 'No swap'
                          : undefined
                      }
                      max={100}
                      unit="%"
                      color="purple"
                    />
                  )}
                  {(schedulerConfig?.collectFds ?? true) && (
                    <MetricGauge
                      label="File Descriptors"
                      value={
                        server.latestMetrics?.maxFds && server.latestMetrics.maxFds > 0
                          ? ((server.latestMetrics.openFds ?? 0) /
                              server.latestMetrics.maxFds) *
                            100
                          : undefined
                      }
                      displayValue={
                        server.latestMetrics?.openFds != null && server.latestMetrics?.maxFds
                          ? `${(server.latestMetrics.openFds / 1000).toFixed(1)}k/${(server.latestMetrics.maxFds / 1000).toFixed(0)}k`
                          : undefined
                      }
                      max={100}
                      unit="%"
                      color="yellow"
                    />
                  )}
                  {(schedulerConfig?.collectTcp ?? true) && (
                    <div className="p-4 rounded-lg bg-slate-800/50">
                      <p className="text-slate-400 text-xs mb-2">TCP Connections</p>
                      {server.latestMetrics?.tcpTotal != null ? (
                        <div className="text-sm">
                          <span className="text-white font-bold text-lg">{server.latestMetrics.tcpTotal}</span>
                          <span className="text-slate-500 text-xs ml-2">total</span>
                          <div className="flex gap-3 mt-1 text-xs">
                            <span className="text-green-400">{server.latestMetrics.tcpEstablished ?? 0} est</span>
                            <span className="text-blue-400">{server.latestMetrics.tcpListen ?? 0} listen</span>
                            <span className="text-yellow-400">{server.latestMetrics.tcpTimeWait ?? 0} tw</span>
                          </div>
                        </div>
                      ) : (
                        <p className="text-slate-500 text-sm">-</p>
                      )}
                    </div>
                  )}
                  <div className="p-4 rounded-lg bg-slate-800/50">
                    <p className="text-slate-400 text-xs mb-2">Uptime</p>
                    {server.latestMetrics?.uptime != null ? (
                      <p className="text-white font-bold text-lg">
                        {Math.floor(server.latestMetrics.uptime / 86400)}d {Math.floor((server.latestMetrics.uptime % 86400) / 3600)}h
                      </p>
                    ) : (
                      <p className="text-slate-500 text-sm">-</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {serversWithMetrics.length === 0 && (
        <div className="card text-center py-12 mb-8">
          <p className="text-slate-400 mb-2">No metrics available</p>
          <p className="text-slate-500 text-sm">
            Enable monitoring on your servers to see resource usage.
          </p>
          <Link to="/servers" className="btn btn-primary mt-4">
            Configure Servers
          </Link>
        </div>
      )}

      {/* Disabled Metrics Section */}
      {schedulerConfig && (() => {
        const disabledMetrics: string[] = [];
        if (!schedulerConfig.collectCpu) disabledMetrics.push('CPU');
        if (!schedulerConfig.collectMemory) disabledMetrics.push('Memory');
        if (!schedulerConfig.collectSwap) disabledMetrics.push('Swap');
        if (!schedulerConfig.collectDisk) disabledMetrics.push('Disk');
        if (!schedulerConfig.collectLoad) disabledMetrics.push('Load Average');
        if (!schedulerConfig.collectFds) disabledMetrics.push('File Descriptors');
        if (!schedulerConfig.collectTcp) disabledMetrics.push('TCP Connections');
        if (!schedulerConfig.collectProcesses) disabledMetrics.push('Top Processes');
        if (!schedulerConfig.collectTcpChecks) disabledMetrics.push('TCP Port Checks');
        if (!schedulerConfig.collectCertChecks) disabledMetrics.push('Certificate Expiry');

        if (disabledMetrics.length === 0) return null;

        return (
          <div className="card mt-6">
            <button
              onClick={() => setDisabledMetricsExpanded(!disabledMetricsExpanded)}
              className="w-full flex items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <svg
                  className={`w-4 h-4 text-slate-400 transition-transform ${disabledMetricsExpanded ? 'rotate-90' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <span className="text-slate-400">Disabled Metrics ({disabledMetrics.length})</span>
              </div>
              <span className="text-xs text-slate-500">Click to expand</span>
            </button>

            {disabledMetricsExpanded && (
              <div className="mt-4 pt-4 border-t border-slate-700">
                <div className="space-y-2">
                  {disabledMetrics.map((metric) => (
                    <div key={metric} className="flex items-center gap-2 text-sm text-slate-400">
                      <span className="w-1.5 h-1.5 bg-slate-600 rounded-full" />
                      <span>{metric}</span>
                      <span className="text-slate-500">- Disabled in environment settings</span>
                    </div>
                  ))}
                </div>
                <Link
                  to="/settings"
                  className="inline-flex items-center gap-1 mt-4 text-sm text-primary-400 hover:text-primary-300"
                >
                  Configure in Settings
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

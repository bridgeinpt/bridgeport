import { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getEnvironmentMetricsSummary,
  getMetricsHistory,
  getModuleSettings,
  unpackSeries,
  type MetricsSummaryServer,
  type MetricsHistoryResponse,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';
import ChartCard from '../components/monitoring/ChartCard';
import MetricGauge from '../components/monitoring/MetricGauge';
import TimeRangeSelector from '../components/monitoring/TimeRangeSelector';
import AutoRefreshToggle from '../components/monitoring/AutoRefreshToggle';
import { useMetricResource } from '../hooks/useMetricResource';
import { mergeColumnarHistory } from '../lib/metricsMerge';

// Stable empty-history fallback so the `historyResource.data ?? EMPTY_HISTORY`
// below produces the same object identity across renders — prevents downstream
// memos (cpuChart, memoryChart, ...) from invalidating every render while the
// initial fetch is in flight.
const EMPTY_HISTORY: MetricsHistoryResponse = Object.freeze({
  servers: [],
  timestamps: [],
  series: {},
}) as MetricsHistoryResponse;

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

  // Issue #171 — three independent resources per page so the chrome paints
  // immediately. `history` carries the chart data (delta-refreshable),
  // `summary` is the per-server table data, and `schedulerConfig` is the
  // module settings used to toggle chart visibility.
  const envId = selectedEnvironment?.id;
  const depKey = useMemo(
    () => `${envId ?? ''}|${monitoringTimeRange}`,
    [envId, monitoringTimeRange]
  );

  const historyResource = useMetricResource<MetricsHistoryResponse>(
    useCallback(
      async (since) => {
        if (!envId) return { servers: [], timestamps: [], series: {} };
        return getMetricsHistory(envId, monitoringTimeRange, {
          since,
          maxPoints: 120,
        });
      },
      [envId, monitoringTimeRange]
    ),
    {
      autoRefreshMs: autoRefreshEnabled ? 30000 : 0,
      depKey,
      enabled: !!envId,
      // Merge delta points onto the existing full window using the columnar
      // merge helper; cap the visible window at a generous 1000 points so
      // long-running auto-refresh sessions don't grow unbounded.
      //
      // The columnar helper works on a generic `entities` field; we adapt
      // the response's `servers` field to `entities` going in and rename it
      // back going out so subsequent ticks (which feed the merged shape
      // back in as `prev`) keep finding `prev.servers`. Without this
      // explicit rename the second delta tick would crash with
      // `history.servers is undefined`.
      merge: (prev, next) => {
        if (next.mode !== 'delta') return next;
        const merged = mergeColumnarHistory(
          {
            entities: prev.servers,
            timestamps: prev.timestamps,
            series: prev.series,
            until: prev.until,
          },
          {
            entities: next.servers ?? [],
            timestamps: next.timestamps,
            series: next.series,
            until: next.until,
          },
          { windowSize: 1000 }
        );
        return {
          servers: merged.entities,
          timestamps: merged.timestamps,
          series: merged.series,
          mode: merged.mode,
          until: merged.until,
        } as MetricsHistoryResponse;
      },
    }
  );

  const summaryResource = useMetricResource<{ servers: MetricsSummaryServer[]; until?: string }>(
    useCallback(async () => {
      if (!envId) return { servers: [] };
      // /monitoring/servers doesn't render any per-server services[] data,
      // so we opt out of the ServiceDeployment + ServiceMetrics queries.
      const res = await getEnvironmentMetricsSummary(envId, { includeServices: false });
      return res;
    }, [envId]),
    {
      autoRefreshMs: autoRefreshEnabled ? 30000 : 0,
      depKey: envId ?? '',
      enabled: !!envId,
    }
  );

  const [schedulerConfig, setSchedulerConfig] = useState<Record<string, unknown> | null>(null);
  const [disabledMetricsExpanded, setDisabledMetricsExpanded] = useState(false);

  // schedulerConfig changes rarely; load it once per envId. Auto-refresh
  // is skipped because the user reloads the page after toggling settings.
  useEffect(() => {
    if (!envId) return;
    let cancelled = false;
    (async () => {
      const res = await getModuleSettings(envId, 'monitoring');
      if (!cancelled) setSchedulerConfig(res.settings);
    })();
    return () => {
      cancelled = true;
    };
  }, [envId]);

  const history: MetricsHistoryResponse = historyResource.data ?? EMPTY_HISTORY;
  const servers: MetricsSummaryServer[] = summaryResource.data?.servers ?? [];
  const historyLoading = historyResource.loading;
  const historyRefreshing = historyResource.refreshing;
  const refreshing = historyRefreshing || summaryResource.refreshing;

  // Combined "refresh all" used by the AutoRefreshToggle button.
  const reloadAll = useCallback(() => {
    historyResource.reload();
    summaryResource.reload();
  }, [historyResource, summaryResource]);

  // Filter by server ID
  const filterSet = useMemo(() => new Set(monitoringServerFilter), [monitoringServerFilter]);

  const filteredServers = useMemo(() => {
    if (filterSet.size === 0) return servers;
    return servers.filter((s) => filterSet.has(s.id));
  }, [servers, filterSet]);

  // Active entity filter for the columnar `unpackSeries` helper — when the
  // server filter is empty we pass `undefined` so all entities are returned.
  const entityIdFilter = useMemo(
    () => (filterSet.size === 0 ? undefined : filterSet),
    [filterSet]
  );

  const handleFilterToggle = useCallback(
    (id: string) => {
      const newFilter = monitoringServerFilter.includes(id)
        ? monitoringServerFilter.filter((i) => i !== id)
        : [...monitoringServerFilter, id];
      setMonitoringServerFilter(newFilter);
    },
    [monitoringServerFilter, setMonitoringServerFilter]
  );

  // Columnar API → Recharts-ready array. We do one unpack per metric so each
  // chart's data array can be memoized independently — the rest of the
  // monitoring code (auto-refresh every 30s) already expects stable refs.
  const cpuChart = useMemo(
    () => unpackSeries({ entities: history.servers, timestamps: history.timestamps, rows: history.series.cpu }, { entityIds: entityIdFilter }),
    [history, entityIdFilter]
  );
  const memoryChart = useMemo(
    () => unpackSeries({ entities: history.servers, timestamps: history.timestamps, rows: history.series.memory }, { entityIds: entityIdFilter }),
    [history, entityIdFilter]
  );
  const swapChart = useMemo(
    () => unpackSeries({ entities: history.servers, timestamps: history.timestamps, rows: history.series.swap }, { entityIds: entityIdFilter }),
    [history, entityIdFilter]
  );
  const diskChart = useMemo(
    () => unpackSeries({ entities: history.servers, timestamps: history.timestamps, rows: history.series.disk }, { entityIds: entityIdFilter }),
    [history, entityIdFilter]
  );
  const loadChart = useMemo(
    () => unpackSeries({ entities: history.servers, timestamps: history.timestamps, rows: history.series.load1 }, { entityIds: entityIdFilter }),
    [history, entityIdFilter]
  );
  const tcpChart = useMemo(
    () => unpackSeries({ entities: history.servers, timestamps: history.timestamps, rows: history.series.tcpTotal }, { entityIds: entityIdFilter }),
    [history, entityIdFilter]
  );

  // True when we have at least one filtered server row that contains a
  // non-null point for any active metric (used to decide whether to show the
  // "no data" card). Regression guard: a weaker gate (just "filtered.length
  // > 0") rendered empty chart cards when the user filtered down to servers
  // with no samples — match the master behaviour of `some(s => s.data.length
  // > 0)` by checking actual non-null values in the columnar series.
  const hasAnyHistory = useMemo(() => {
    if (history.timestamps.length === 0) return false;
    const filtered = filterSet.size === 0
      ? history.servers
      : history.servers.filter((s) => filterSet.has(s.id));
    if (filtered.length === 0) return false;

    const filteredIdxs = filtered.map((s) => history.servers.indexOf(s));
    for (const series of Object.values(history.series)) {
      if (!series) continue;
      for (const idx of filteredIdxs) {
        const row = series[idx];
        if (row && row.some((v) => v !== null)) return true;
      }
    }
    return false;
  }, [history, filterSet]);

  const formatTime = (time: string) => {
    const date = new Date(time);
    if (monitoringTimeRange <= 24) {
      return format(date, 'HH:mm');
    } else {
      return format(date, 'MMM d HH:mm');
    }
  };

  // Page-level render gate dropped (issue #171). Each chart/table renders
  // its own loading state below so the page chrome paints immediately.
  const serversWithMetrics = filteredServers.filter((s) => s.latestMetrics);

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-5">
        <AutoRefreshToggle
          enabled={autoRefreshEnabled}
          onChange={setAutoRefreshEnabled}
          onRefresh={reloadAll}
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

      {/* Server Charts — each card renders its own loading skeleton so the
          page chrome above paints immediately (issue #171). */}
      {historyLoading || hasAnyHistory ? (
        <div className="grid grid-cols-2 gap-6 mb-8">
          {(schedulerConfig?.collectCpu ?? true) && (
            <ChartCard title="CPU Usage" data={cpuChart.data} names={cpuChart.names} formatTime={formatTime} unit="%" domain={[0, 100]} loading={historyLoading} refreshing={historyRefreshing} />
          )}
          {(schedulerConfig?.collectMemory ?? true) && (
            <ChartCard title="Memory Usage" data={memoryChart.data} names={memoryChart.names} formatTime={formatTime} unit="%" domain={[0, 100]} loading={historyLoading} refreshing={historyRefreshing} />
          )}
          {(schedulerConfig?.collectSwap ?? true) && (
            <ChartCard title="Swap Usage" data={swapChart.data} names={swapChart.names} formatTime={formatTime} unit="%" domain={[0, 100]} loading={historyLoading} refreshing={historyRefreshing} />
          )}
          {(schedulerConfig?.collectDisk ?? true) && (
            <ChartCard title="Disk Usage" data={diskChart.data} names={diskChart.names} formatTime={formatTime} unit="%" domain={[0, 100]} loading={historyLoading} refreshing={historyRefreshing} />
          )}
          {(schedulerConfig?.collectLoad ?? true) && (
            <ChartCard title="Load Average" data={loadChart.data} names={loadChart.names} formatTime={formatTime} domain={[0, 'auto']} loading={historyLoading} refreshing={historyRefreshing} />
          )}
          {(schedulerConfig?.collectTcp ?? true) && (
            <ChartCard title="TCP Connections" data={tcpChart.data} names={tcpChart.names} formatTime={formatTime} domain={[0, 'auto']} loading={historyLoading} refreshing={historyRefreshing} />
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

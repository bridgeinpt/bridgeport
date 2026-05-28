import { useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getServiceMetricsHistory,
  getEnvironmentMetricsSummary,
  unpackSeries,
  type ServiceMetricsHistoryResponse,
  type MetricsSummaryServer,
  type ServiceMetrics,
} from '../lib/api';
import { format } from 'date-fns';
import ChartCard from '../components/monitoring/ChartCard';
import TimeRangeSelector from '../components/monitoring/TimeRangeSelector';
import AutoRefreshToggle from '../components/monitoring/AutoRefreshToggle';
import { useMetricResource } from '../hooks/useMetricResource';
import { mergeColumnarHistory } from '../lib/metricsMerge';

// Stable empty-history fallback (see MonitoringServers for rationale).
const EMPTY_HISTORY: ServiceMetricsHistoryResponse = Object.freeze({
  services: [],
  timestamps: [],
  series: {},
}) as ServiceMetricsHistoryResponse;

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

  const envId = selectedEnvironment?.id;
  const depKey = useMemo(
    () => `${envId ?? ''}|${monitoringTimeRange}`,
    [envId, monitoringTimeRange]
  );

  // Issue #171 — split into independent resources so the page chrome
  // (toggles, filters) paints immediately and each card carries its own
  // skeleton / refreshing badge.
  const historyResource = useMetricResource<ServiceMetricsHistoryResponse>(
    useCallback(
      async (since) => {
        if (!envId) return { services: [], timestamps: [], series: {} };
        return getServiceMetricsHistory(envId, monitoringTimeRange, {
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
      // See MonitoringServers for the rationale on the explicit rename —
      // mergeColumnarHistory works on a generic `entities` field, and we
      // need to project it back to `services` so subsequent ticks (which
      // feed the merged shape back in as `prev`) keep finding `prev.services`.
      merge: (prev, next) => {
        if (next.mode !== 'delta') return next;
        const merged = mergeColumnarHistory(
          {
            entities: prev.services,
            timestamps: prev.timestamps,
            series: prev.series,
            until: prev.until,
          },
          {
            entities: next.services ?? [],
            timestamps: next.timestamps,
            series: next.series,
            until: next.until,
          },
          { windowSize: 1000 }
        );
        return {
          services: merged.entities,
          timestamps: merged.timestamps,
          series: merged.series,
          mode: merged.mode,
          until: merged.until,
        } as ServiceMetricsHistoryResponse;
      },
    }
  );

  // Services page DOES use per-server services[] data (for the table), so
  // we keep `includeServices: true` here (the default).
  const summaryResource = useMetricResource<{ servers: MetricsSummaryServer[]; until?: string }>(
    useCallback(async () => {
      if (!envId) return { servers: [] };
      return getEnvironmentMetricsSummary(envId);
    }, [envId]),
    {
      autoRefreshMs: autoRefreshEnabled ? 30000 : 0,
      depKey: envId ?? '',
      enabled: !!envId,
    }
  );

  const servers: MetricsSummaryServer[] = summaryResource.data?.servers ?? [];
  const history: ServiceMetricsHistoryResponse = historyResource.data ?? EMPTY_HISTORY;
  const historyLoading = historyResource.loading;
  const historyRefreshing = historyResource.refreshing;
  const refreshing = historyRefreshing || summaryResource.refreshing;

  const reloadAll = useCallback(() => {
    historyResource.reload();
    summaryResource.reload();
  }, [historyResource, summaryResource]);

  // All service names for the filter (from history, sorted)
  const allServices = useMemo(() => {
    return history.services
      .map((s) => ({ id: s.id, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [history.services]);

  // Filter by service ID
  const filterSet = useMemo(() => new Set(monitoringServiceFilter), [monitoringServiceFilter]);

  const filteredServers = useMemo(() => {
    if (filterSet.size === 0) return servers;
    // Only include servers that have at least one selected service
    const matchingServerIds = new Set(
      history.services.filter((s) => filterSet.has(s.id)).map((s) => s.serverId)
    );
    return servers.filter((s) => matchingServerIds.has(s.id));
  }, [servers, filterSet, history.services]);

  const entityIdFilter = useMemo(
    () => (filterSet.size === 0 ? undefined : filterSet),
    [filterSet]
  );

  const handleFilterToggle = useCallback(
    (id: string) => {
      const newFilter = monitoringServiceFilter.includes(id)
        ? monitoringServiceFilter.filter((i) => i !== id)
        : [...monitoringServiceFilter, id];
      setMonitoringServiceFilter(newFilter);
    },
    [monitoringServiceFilter, setMonitoringServiceFilter]
  );

  // Columnar → Recharts via the shared helper. One unpack per metric so each
  // chart's data array gets its own memo identity.
  const cpuChart = useMemo(
    () => unpackSeries({ entities: history.services, timestamps: history.timestamps, rows: history.series.cpu }, { entityIds: entityIdFilter }),
    [history, entityIdFilter]
  );
  const memoryChart = useMemo(
    () => unpackSeries({ entities: history.services, timestamps: history.timestamps, rows: history.series.memory }, { entityIds: entityIdFilter }),
    [history, entityIdFilter]
  );
  const networkRxChart = useMemo(
    () => unpackSeries({ entities: history.services, timestamps: history.timestamps, rows: history.series.networkRx }, { entityIds: entityIdFilter }),
    [history, entityIdFilter]
  );
  const networkTxChart = useMemo(
    () => unpackSeries({ entities: history.services, timestamps: history.timestamps, rows: history.series.networkTx }, { entityIds: entityIdFilter }),
    [history, entityIdFilter]
  );

  // Regression guard: a weaker "filtered.length > 0" check rendered empty
  // chart cards when the user filtered down to services with no samples —
  // match the master behaviour of `some(s => s.data.length > 0)` by checking
  // actual non-null values in the columnar series.
  const hasAnyHistory = useMemo(() => {
    if (history.timestamps.length === 0) return false;
    const filtered = filterSet.size === 0
      ? history.services
      : history.services.filter((s) => filterSet.has(s.id));
    if (filtered.length === 0) return false;

    const filteredIdxs = filtered.map((s) => history.services.indexOf(s));
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

  // Page-level render gate dropped (issue #171). Chart cards below show
  // their own skeleton while the initial history fetch is in flight.

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

      {/* Service Charts and Table — per-card loading skeletons (issue #171). */}
      {historyLoading || hasAnyHistory ? (
        <>
          <div className="grid grid-cols-2 gap-6 mb-8">
            <ChartCard title="CPU Usage" data={cpuChart.data} names={cpuChart.names} formatTime={formatTime} unit="%" domain={[0, 'auto']} loading={historyLoading} refreshing={historyRefreshing} />
            <ChartCard title="Memory Usage" data={memoryChart.data} names={memoryChart.names} formatTime={formatTime} unit=" MB" domain={[0, 'auto']} loading={historyLoading} refreshing={historyRefreshing} />
            <ChartCard title="Network RX" data={networkRxChart.data} names={networkRxChart.names} formatTime={formatTime} unit=" MB" domain={[0, 'auto']} loading={historyLoading} refreshing={historyRefreshing} />
            <ChartCard title="Network TX" data={networkTxChart.data} names={networkTxChart.names} formatTime={formatTime} unit=" MB" domain={[0, 'auto']} loading={historyLoading} refreshing={historyRefreshing} />
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

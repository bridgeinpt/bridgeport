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
import { EntityFilterPills } from '@/components/monitoring/EntityFilterPills';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
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
            <span className="text-sm text-muted-foreground">Services:</span>
            <EntityFilterPills
              items={allServices}
              selected={monitoringServiceFilter}
              onToggle={handleFilterToggle}
              onClear={() => setMonitoringServiceFilter([])}
            />
          </div>
        )}
      </div>

      {/* Service Charts and Table — per-card loading skeletons (issue #171). */}
      {historyLoading || hasAnyHistory ? (
        <>
          <div className="grid grid-cols-2 gap-6 mb-8">
            <ChartCard title="CPU Usage" data={cpuChart.data} names={cpuChart.names} formatTime={formatTime} unit="%" domain={[0, 100]} loading={historyLoading} refreshing={historyRefreshing} />
            <ChartCard title="Memory Usage" data={memoryChart.data} names={memoryChart.names} formatTime={formatTime} unit=" MB" domain={[0, 'auto']} loading={historyLoading} refreshing={historyRefreshing} />
            <ChartCard title="Network RX" data={networkRxChart.data} names={networkRxChart.names} formatTime={formatTime} unit=" MB" domain={[0, 'auto']} loading={historyLoading} refreshing={historyRefreshing} />
            <ChartCard title="Network TX" data={networkTxChart.data} names={networkTxChart.names} formatTime={formatTime} unit=" MB" domain={[0, 'auto']} loading={historyLoading} refreshing={historyRefreshing} />
          </div>

          {/* Services Table */}
          {servicesWithMetrics.length > 0 && (
            <Card className="p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4">
                Service Resource Usage
              </h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Service</TableHead>
                    <TableHead>Server</TableHead>
                    <TableHead>CPU</TableHead>
                    <TableHead>Memory</TableHead>
                    <TableHead>Network I/O</TableHead>
                    <TableHead>Restarts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {servicesWithMetrics.map((service) => (
                    <TableRow key={service.id}>
                      <TableCell>
                        <Link
                          to={`/services/${service.id}`}
                          className="text-foreground hover:text-primary"
                        >
                          {service.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/servers/${service.serverId}`}
                          className="text-muted-foreground hover:text-primary"
                        >
                          {service.serverName}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            (service.metrics.cpuPercent || 0) > 80 && 'text-destructive'
                          )}
                        >
                          {service.metrics.cpuPercent?.toFixed(1) ?? '-'}%
                        </span>
                      </TableCell>
                      <TableCell>
                        {service.metrics.memoryUsedMb != null ? (
                          <span>
                            {service.metrics.memoryUsedMb.toFixed(0)}MB
                            {service.metrics.memoryLimitMb != null && (
                              <span className="text-muted-foreground">
                                {' '}
                                / {service.metrics.memoryLimitMb.toFixed(0)}MB
                              </span>
                            )}
                          </span>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell className="text-sm font-mono">
                        {service.metrics.networkRxMb != null || service.metrics.networkTxMb != null ? (
                          <span>
                            <span className="text-success">
                              {service.metrics.networkRxMb?.toFixed(1) ?? '0'}
                            </span>
                            /
                            <span className="text-info">
                              {service.metrics.networkTxMb?.toFixed(1) ?? '0'}
                            </span>
                            MB
                          </span>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell>
                        {service.metrics.restartCount != null ? (
                          <span
                            className={cn(service.metrics.restartCount > 0 && 'text-warning')}
                          >
                            {service.metrics.restartCount}
                          </span>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      ) : (
        <EmptyState
          message="No service metrics available"
          description="Deploy a monitoring agent to collect service metrics."
        >
          <Button asChild className="mt-4">
            <Link to="/monitoring/agents#agents">Configure Agents</Link>
          </Button>
        </EmptyState>
      )}
    </div>
  );
}

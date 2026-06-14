import { memo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useAppStore } from '../lib/store';
import {
  getMonitoringOverview,
  getEnvironmentMetricsSummary,
  getDatabaseMonitoringSummary,
  type MonitoringOverviewStats,
  type MetricsSummaryServer,
  type DatabaseMonitoringSummaryItem,
} from '../lib/api';
import { ServerIcon, CubeIcon, DatabaseIcon } from '../components/Icons';
import { formatDistanceToNow } from 'date-fns';
import { useMetricResource } from '../hooks/useMetricResource';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import AutoRefreshToggle from '../components/monitoring/AutoRefreshToggle';

interface FlatService {
  id: string;
  name: string;
  containerName: string;
  serverName: string;
  cpuPercent: number | null;
  memoryUsedMb: number | null;
}

export default function Monitoring() {
  const { selectedEnvironment, autoRefreshEnabled, setAutoRefreshEnabled } = useAppStore();

  // Issue #171 — three independent resources so the page chrome paints
  // immediately. Each section (HealthCards, Servers table, Services
  // table, Databases table) renders its own loading state.
  const envId = selectedEnvironment?.id;

  const overviewResource = useMetricResource<{ stats: MonitoringOverviewStats; until?: string }>(
    useCallback(async () => {
      if (!envId) return { stats: { servers: { total: 0, healthy: 0, unhealthy: 0 }, services: { total: 0, healthy: 0, unhealthy: 0 }, databases: { total: 0, monitored: 0, connected: 0, error: 0 }, alerts: 0 } };
      return getMonitoringOverview(envId);
    }, [envId]),
    {
      autoRefreshMs: autoRefreshEnabled ? 30000 : 0,
      depKey: envId ?? '',
      enabled: !!envId,
    }
  );

  // The overview page renders per-server services[] data (`flatServices`)
  // so we keep includeServices=true (the default).
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

  const databasesResource = useMetricResource<{ databases: DatabaseMonitoringSummaryItem[]; until?: string }>(
    useCallback(async () => {
      if (!envId) return { databases: [] };
      return getDatabaseMonitoringSummary(envId);
    }, [envId]),
    {
      autoRefreshMs: autoRefreshEnabled ? 30000 : 0,
      depKey: envId ?? '',
      enabled: !!envId,
    }
  );

  const stats = overviewResource.data?.stats ?? null;
  const servers = summaryResource.data?.servers ?? [];
  const databases = databasesResource.data?.databases ?? [];
  const refreshing =
    overviewResource.refreshing ||
    summaryResource.refreshing ||
    databasesResource.refreshing;

  const reloadAll = useCallback(() => {
    overviewResource.reload();
    summaryResource.reload();
    databasesResource.reload();
  }, [overviewResource, summaryResource, databasesResource]);

  // Flatten services from servers
  const flatServices: FlatService[] = servers.flatMap((s) =>
    s.services
      .filter((svc) => svc.latestMetrics)
      .map((svc) => ({
        id: svc.id,
        name: svc.name,
        containerName: svc.containerName,
        serverName: s.name,
        cpuPercent: svc.latestMetrics!.cpuPercent,
        memoryUsedMb: svc.latestMetrics!.memoryUsedMb,
      }))
  );
  flatServices.sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0));

  // Sort servers: unhealthy first, then by name
  const sortedServers = [...servers].sort((a, b) => {
    const aHealthy = a.latestMetrics != null;
    const bHealthy = b.latestMetrics != null;
    if (aHealthy !== bHealthy) return aHealthy ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  // Filter and sort databases: monitored only, error first then by name
  const monitoredDbs = databases
    .filter((d) => d.monitoringEnabled)
    .sort((a, b) => {
      if (a.monitoringStatus !== b.monitoringStatus) {
        if (a.monitoringStatus === 'error') return -1;
        if (b.monitoringStatus === 'error') return 1;
      }
      return a.name.localeCompare(b.name);
    });

  // Page-level render gate dropped (issue #171). Health cards below paint
  // immediately; the section-level lists show skeletons until their own
  // fetches return.
  const overviewLoading = overviewResource.loading;

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

      {/* Health Sections */}
      {overviewLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : stats && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <HealthCard
            title="Servers Health"
            href="/monitoring/servers"
            icon={ServerIcon}
            total={stats.servers.total}
            healthy={stats.servers.healthy}
            unhealthy={stats.servers.unhealthy}
            color="blue"
          />
          <HealthCard
            title="Services Health"
            href="/monitoring/services"
            icon={CubeIcon}
            total={stats.services.total}
            healthy={stats.services.healthy}
            unhealthy={stats.services.unhealthy}
            color="green"
          />
          <HealthCard
            title="Databases Health"
            href="/monitoring/databases"
            icon={DatabaseIcon}
            total={stats.databases.total}
            healthy={stats.databases.connected}
            unhealthy={stats.databases.error}
            color="purple"
          />
        </div>
      )}

      {/* Servers Table */}
      {sortedServers.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ServerIcon className="w-4 h-4 text-info" />
              <span className="text-sm font-semibold text-foreground">Servers</span>
            </div>
            <Link to="/monitoring/servers" className="text-xs text-primary hover:text-primary/80">View all</Link>
          </div>
          <Card className="gap-0 py-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">CPU</TableHead>
                  <TableHead className="text-right">Memory</TableHead>
                  <TableHead className="text-right">Disk</TableHead>
                  <TableHead className="text-right">Load</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedServers.map((s) => {
                  const m = s.latestMetrics;
                  const memPct = m?.memoryUsedMb != null && m?.memoryTotalMb
                    ? Math.round((m.memoryUsedMb / m.memoryTotalMb) * 100)
                    : null;
                  const diskPct = m?.diskUsedGb != null && m?.diskTotalGb
                    ? Math.round((m.diskUsedGb / m.diskTotalGb) * 100)
                    : null;
                  return (
                    <TableRow key={s.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${m ? 'bg-success' : 'bg-muted-foreground'}`} />
                          <Link to={`/servers/${s.id}`} className="text-foreground hover:text-primary font-medium truncate">
                            {s.name}
                          </Link>
                        </div>
                      </TableCell>
                      {m ? (
                        <>
                          <TableCell className="text-right tabular-nums">
                            <MetricValue value={m.cpuPercent} suffix="%" warn={80} crit={95} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <MetricValue value={memPct} suffix="%" warn={80} crit={95} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <MetricValue value={diskPct} suffix="%" warn={80} crit={95} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {m.loadAvg1 != null ? m.loadAvg1.toFixed(2) : '-'}
                          </TableCell>
                        </>
                      ) : (
                        <TableCell colSpan={4} className="text-muted-foreground text-xs text-center">
                          No metrics
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}

      {/* Services Table */}
      {flatServices.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CubeIcon className="w-4 h-4 text-success" />
              <span className="text-sm font-semibold text-foreground">Services</span>
            </div>
            <Link to="/monitoring/services" className="text-xs text-primary hover:text-primary/80">View all</Link>
          </div>
          <Card className="gap-0 py-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead className="text-right">CPU</TableHead>
                  <TableHead className="text-right">Memory</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flatServices.map((svc) => (
                  <TableRow key={svc.id}>
                    <TableCell>
                      <Link to={`/services/${svc.id}`} className="text-foreground hover:text-primary font-medium truncate">
                        {svc.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{svc.serverName}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <MetricValue value={svc.cpuPercent} suffix="%" warn={80} crit={95} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {svc.memoryUsedMb != null ? `${Math.round(svc.memoryUsedMb)} MB` : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}

      {/* Databases Table */}
      {monitoredDbs.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <DatabaseIcon className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-semibold text-foreground">Databases</span>
            </div>
            <Link to="/monitoring/databases" className="text-xs text-primary hover:text-primary/80">View all</Link>
          </div>
          <Card className="gap-0 py-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead className="text-right">Last Collection</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {monitoredDbs.map((db) => (
                  <TableRow key={db.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          db.monitoringStatus === 'connected' ? 'bg-success' :
                          db.monitoringStatus === 'error' ? 'bg-destructive' : 'bg-warning'
                        }`} />
                        <Link to={`/databases/${db.id}`} className="text-foreground hover:text-primary font-medium truncate">
                          {db.name}
                        </Link>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="neutral" className="text-xs">
                        {db.databaseType?.displayName || db.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{db.serverName || '-'}</TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs">
                      {db.lastCollectedAt
                        ? formatDistanceToNow(new Date(db.lastCollectedAt), { addSuffix: true })
                        : 'Never'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}
    </div>
  );
}

interface HealthCardProps {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  total: number;
  healthy: number;
  unhealthy: number;
  color: 'blue' | 'green' | 'purple';
}

const HEALTH_COLORS = {
  blue: { icon: 'text-info', bar: 'bg-info' },
  green: { icon: 'text-success', bar: 'bg-success' },
  purple: { icon: 'text-purple-400', bar: 'bg-purple-500' },
} as const;

const HealthCard = memo(function HealthCard({ title, href, icon: Icon, total, healthy, unhealthy, color }: HealthCardProps) {
  const unknown = Math.max(0, total - healthy - unhealthy);
  const healthPct = total > 0 ? Math.round((healthy / total) * 100) : 0;

  return (
    <Link to={href} className="group">
      <Card className="gap-0 p-4 transition-colors hover:border-ring">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <Icon className={`w-5 h-5 ${HEALTH_COLORS[color].icon}`} />
            <span className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">{title}</span>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
        </div>

        {total === 0 ? (
          <p className="text-muted-foreground text-sm">No resources configured</p>
        ) : (
          <>
            {/* Progress bar — hand-rolled so each card keeps its per-domain
                accent color (shadcn Progress hardcodes the indicator to the
                primary token). */}
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden mb-3">
              {healthy > 0 && (
                <div
                  className={`h-full ${HEALTH_COLORS[color].bar} rounded-full`}
                  style={{ width: `${healthPct}%` }}
                />
              )}
            </div>

            <div className="flex items-center justify-between text-xs">
              <div className="flex gap-3">
                <span className="text-success">{healthy} healthy</span>
                {unhealthy > 0 && <span className="text-destructive">{unhealthy} unhealthy</span>}
                {unknown > 0 && <span className="text-muted-foreground">{unknown} unknown</span>}
              </div>
              <span className="text-muted-foreground">{total} total</span>
            </div>
          </>
        )}
      </Card>
    </Link>
  );
});

function MetricValue({ value, suffix, warn, crit }: { value: number | null; suffix: string; warn: number; crit: number }) {
  if (value == null) return <span className="text-muted-foreground">-</span>;
  const rounded = Math.round(value);
  const color = rounded >= crit ? 'text-destructive' : rounded >= warn ? 'text-warning' : 'text-muted-foreground';
  return <span className={color}>{rounded}{suffix}</span>;
}

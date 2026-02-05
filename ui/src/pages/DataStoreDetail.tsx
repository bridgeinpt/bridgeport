import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  getDataStore,
  updateDataStore,
  deleteDataStore,
  testDataStoreConnection,
  getDataStoreMetrics,
  collectDataStoreMetricsNow,
  discoverRedisCluster,
  listServers,
  type DataStore,
  type DataStoreInput,
  type DataStoreMetricsEntry,
  type RedisMetrics,
  type PostgresMetrics,
  type SqliteMetrics,
  type Server,
} from '../lib/api';
import { formatDistanceToNow, format, subHours } from 'date-fns';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'connected':
      return 'bg-green-500/20 text-green-400';
    case 'error':
      return 'bg-red-500/20 text-red-400';
    default:
      return 'bg-slate-500/20 text-slate-400';
  }
}

type TimeRange = '1h' | '6h' | '24h' | '7d';

export default function DataStoreDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { selectedEnvironment, autoRefreshEnabled, setAutoRefreshEnabled } = useAppStore();

  const [dataStore, setDataStore] = useState<DataStore | null>(null);
  const [metrics, setMetrics] = useState<DataStoreMetricsEntry[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [testing, setTesting] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [discoveringCluster, setDiscoveringCluster] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<DataStoreInput>>({});

  const [timeRange, setTimeRange] = useState<TimeRange>('6h');

  const loadDataStore = useCallback(async () => {
    if (!id) return;
    try {
      const { dataStore: ds } = await getDataStore(id);
      setDataStore(ds);
      setEditForm({
        name: ds.name,
        enabled: ds.enabled,
        collectionIntervalSec: ds.collectionIntervalSec,
        host: ds.host || undefined,
        port: ds.port || undefined,
        databaseName: ds.databaseName || undefined,
        redisDb: ds.redisDb || undefined,
        serverId: ds.serverId || undefined,
        filePath: ds.filePath || undefined,
        isCluster: ds.isCluster,
      });
    } catch {
      navigate('/monitoring/data-stores');
    }
  }, [id, navigate]);

  const loadMetrics = useCallback(async () => {
    if (!id) return;
    setLoadingMetrics(true);
    try {
      const hoursMap: Record<TimeRange, number> = {
        '1h': 1,
        '6h': 6,
        '24h': 24,
        '7d': 168,
      };
      const hours = hoursMap[timeRange];
      const from = subHours(new Date(), hours).toISOString();
      const { metrics: m } = await getDataStoreMetrics(id, from, undefined, 500);
      setMetrics(m.reverse()); // Oldest first for charts
    } finally {
      setLoadingMetrics(false);
    }
  }, [id, timeRange]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await loadDataStore();
      if (selectedEnvironment?.id) {
        const { servers: s } = await listServers(selectedEnvironment.id);
        setServers(s);
      }
      setLoading(false);
    };
    load();
  }, [loadDataStore, selectedEnvironment?.id]);

  useEffect(() => {
    if (!loading && dataStore) {
      loadMetrics();
    }
  }, [loading, dataStore, loadMetrics]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefreshEnabled || !id) return;
    const interval = setInterval(() => {
      loadDataStore();
      loadMetrics();
    }, 30000);
    return () => clearInterval(interval);
  }, [autoRefreshEnabled, id, loadDataStore, loadMetrics]);

  const handleTest = async () => {
    if (!id) return;
    setTesting(true);
    try {
      await testDataStoreConnection(id);
      await loadDataStore();
    } finally {
      setTesting(false);
    }
  };

  const handleCollect = async () => {
    if (!id) return;
    setCollecting(true);
    try {
      await collectDataStoreMetricsNow(id);
      await loadDataStore();
      await loadMetrics();
    } finally {
      setCollecting(false);
    }
  };

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    try {
      await updateDataStore(id, editForm);
      await loadDataStore();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !dataStore) return;
    if (!confirm(`Delete data store "${dataStore.name}"? This will also delete all collected metrics.`)) {
      return;
    }
    setDeleting(true);
    try {
      await deleteDataStore(id);
      navigate('/monitoring/data-stores');
    } finally {
      setDeleting(false);
    }
  };

  const handleDiscoverCluster = async () => {
    if (!id) return;
    setDiscoveringCluster(true);
    try {
      const result = await discoverRedisCluster(id);
      if (result.isCluster) {
        await loadDataStore();
      }
    } finally {
      setDiscoveringCluster(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-slate-700 rounded" />
          <div className="h-32 bg-slate-700 rounded" />
          <div className="h-64 bg-slate-700 rounded" />
        </div>
      </div>
    );
  }

  if (!dataStore) {
    return (
      <div className="p-6">
        <p className="text-slate-400">Data store not found</p>
      </div>
    );
  }

  const latestMetrics = metrics[metrics.length - 1]?.metrics;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link
            to="/monitoring/data-stores"
            className="text-slate-400 hover:text-white"
          >
            &larr; Back
          </Link>
          <span className="text-xl font-bold text-white">{dataStore.name}</span>
          <span className={`px-2 py-0.5 text-xs rounded-full ${getStatusColor(dataStore.status)}`}>
            {dataStore.status}
          </span>
          {!dataStore.enabled && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-slate-600 text-slate-400">
              Disabled
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={autoRefreshEnabled}
              onChange={(e) => setAutoRefreshEnabled(e.target.checked)}
              className="rounded bg-slate-700 border-slate-600"
            />
            Auto: 30s
          </label>
          <button
            onClick={handleTest}
            disabled={testing}
            className="btn btn-secondary"
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          <button
            onClick={handleCollect}
            disabled={collecting || !dataStore.enabled}
            className="btn btn-primary"
          >
            {collecting ? 'Collecting...' : 'Collect Now'}
          </button>
        </div>
      </div>

      {/* Error message */}
      {dataStore.lastError && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
          <div className="text-red-400 font-medium mb-1">Connection Error</div>
          <div className="text-slate-400 text-sm">{dataStore.lastError}</div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Configuration */}
        <div className="space-y-6">
          {/* Connection Info */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-slate-400">Configuration</h3>
              {!editing ? (
                <button
                  onClick={() => setEditing(true)}
                  className="btn btn-secondary px-2 py-1 text-xs"
                >
                  Edit
                </button>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditing(false)}
                    className="btn btn-secondary px-2 py-1 text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="btn btn-primary px-2 py-1 text-xs"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              )}
            </div>

            {editing ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-slate-500 mb-1">Name</label>
                  <input
                    type="text"
                    value={editForm.name || ''}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    className="input w-full"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editForm.enabled ?? true}
                    onChange={(e) => setEditForm({ ...editForm, enabled: e.target.checked })}
                    className="rounded bg-slate-700 border-slate-600"
                  />
                  <label className="text-sm text-slate-400">Enabled</label>
                </div>
                <div>
                  <label className="block text-sm text-slate-500 mb-1">Collection Interval (seconds)</label>
                  <input
                    type="number"
                    value={editForm.collectionIntervalSec || 60}
                    onChange={(e) => setEditForm({ ...editForm, collectionIntervalSec: parseInt(e.target.value) })}
                    className="input w-full"
                    min={10}
                    max={3600}
                  />
                </div>
                {dataStore.type !== 'sqlite' && (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-2">
                        <label className="block text-sm text-slate-500 mb-1">Host</label>
                        <input
                          type="text"
                          value={editForm.host || ''}
                          onChange={(e) => setEditForm({ ...editForm, host: e.target.value })}
                          className="input w-full"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-slate-500 mb-1">Port</label>
                        <input
                          type="number"
                          value={editForm.port || ''}
                          onChange={(e) => setEditForm({ ...editForm, port: parseInt(e.target.value) })}
                          className="input w-full"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm text-slate-500 mb-1">Password</label>
                      <input
                        type="password"
                        placeholder="Leave empty to keep current"
                        onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                        className="input w-full"
                      />
                    </div>
                  </>
                )}
                {dataStore.type === 'sqlite' && (
                  <>
                    <div>
                      <label className="block text-sm text-slate-500 mb-1">Server</label>
                      <select
                        value={editForm.serverId || ''}
                        onChange={(e) => setEditForm({ ...editForm, serverId: e.target.value })}
                        className="input w-full"
                      >
                        <option value="">Select a server...</option>
                        {servers.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm text-slate-500 mb-1">File Path</label>
                      <input
                        type="text"
                        value={editForm.filePath || ''}
                        onChange={(e) => setEditForm({ ...editForm, filePath: e.target.value })}
                        className="input w-full font-mono"
                      />
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">Type</span>
                  <span className="text-white capitalize">{dataStore.type}</span>
                </div>
                {dataStore.type !== 'sqlite' && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Host</span>
                    <span className="text-white font-mono">{dataStore.host}:{dataStore.port}</span>
                  </div>
                )}
                {dataStore.type === 'postgres' && dataStore.databaseName && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Database</span>
                    <span className="text-white font-mono">{dataStore.databaseName}</span>
                  </div>
                )}
                {dataStore.type === 'redis' && dataStore.redisDb !== null && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">DB Number</span>
                    <span className="text-white">{dataStore.redisDb}</span>
                  </div>
                )}
                {dataStore.type === 'sqlite' && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Server</span>
                      <span className="text-white">{dataStore.server?.name || 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Path</span>
                      <span className="text-white font-mono text-xs">{dataStore.filePath}</span>
                    </div>
                  </>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-500">Collection Interval</span>
                  <span className="text-white">{dataStore.collectionIntervalSec}s</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Last Collection</span>
                  <span className="text-white">
                    {dataStore.lastCollectedAt
                      ? formatDistanceToNow(new Date(dataStore.lastCollectedAt), { addSuffix: true })
                      : 'Never'}
                  </span>
                </div>
                {dataStore.type === 'redis' && (
                  <div className="flex justify-between items-center">
                    <span className="text-slate-500">Cluster Mode</span>
                    <div className="flex items-center gap-2">
                      <span className="text-white">{dataStore.isCluster ? 'Yes' : 'No'}</span>
                      {!dataStore.isCluster && (
                        <button
                          onClick={handleDiscoverCluster}
                          disabled={discoveringCluster}
                          className="text-xs text-brand-400 hover:text-brand-300"
                        >
                          {discoveringCluster ? 'Discovering...' : 'Discover'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="card">
            <h3 className="text-sm font-medium text-slate-400 mb-4">Actions</h3>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="btn btn-danger w-full"
            >
              {deleting ? 'Deleting...' : 'Delete Data Store'}
            </button>
          </div>
        </div>

        {/* Right Column - Metrics */}
        <div className="lg:col-span-2 space-y-6">
          {/* Current Metrics */}
          {latestMetrics && (
            <div className="card">
              <h3 className="text-sm font-medium text-slate-400 mb-4">Current Metrics</h3>
              {dataStore.type === 'redis' && 'hitRate' in latestMetrics && (
                <RedisCurrentMetrics metrics={latestMetrics} />
              )}
              {dataStore.type === 'postgres' && 'activeConnections' in latestMetrics && (
                <PostgresCurrentMetrics metrics={latestMetrics} />
              )}
              {dataStore.type === 'sqlite' && 'fileSizeBytes' in latestMetrics && (
                <SqliteCurrentMetrics metrics={latestMetrics} />
              )}
            </div>
          )}

          {/* Time Range Selector */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-slate-400">Metrics History</h3>
            <div className="flex gap-1">
              {(['1h', '6h', '24h', '7d'] as TimeRange[]).map((range) => (
                <button
                  key={range}
                  onClick={() => setTimeRange(range)}
                  className={`px-3 py-1 text-sm rounded ${
                    timeRange === range
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>
          </div>

          {/* Charts */}
          {loadingMetrics ? (
            <div className="card animate-pulse h-64 bg-slate-700 rounded" />
          ) : metrics.length === 0 ? (
            <div className="card text-center py-12 text-slate-400">
              No metrics collected yet
            </div>
          ) : (
            <>
              {dataStore.type === 'redis' && (
                <RedisCharts metrics={metrics as DataStoreMetricsEntry[]} />
              )}
              {dataStore.type === 'postgres' && (
                <PostgresCharts metrics={metrics as DataStoreMetricsEntry[]} />
              )}
              {dataStore.type === 'sqlite' && (
                <SqliteCharts metrics={metrics as DataStoreMetricsEntry[]} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Redis Current Metrics Component
function RedisCurrentMetrics({ metrics }: { metrics: RedisMetrics }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MetricCard
        label="Hit Rate"
        value={metrics.hitRate !== null ? `${(metrics.hitRate * 100).toFixed(1)}%` : 'N/A'}
        color={metrics.hitRate !== null && metrics.hitRate < 0.8 ? 'text-yellow-400' : 'text-green-400'}
      />
      <MetricCard
        label="Memory"
        value={metrics.memoryUsagePercent !== null ? `${metrics.memoryUsagePercent.toFixed(1)}%` : 'N/A'}
        subtext={formatBytes(metrics.usedMemoryBytes)}
        color={metrics.memoryUsagePercent !== null && metrics.memoryUsagePercent > 80 ? 'text-red-400' : 'text-white'}
      />
      <MetricCard
        label="Ops/sec"
        value={metrics.opsPerSec.toLocaleString()}
        color="text-white"
      />
      <MetricCard
        label="Clients"
        value={`${metrics.connectedClients}`}
        subtext={metrics.blockedClients > 0 ? `${metrics.blockedClients} blocked` : undefined}
        color={metrics.blockedClients > 0 ? 'text-yellow-400' : 'text-white'}
      />
      <MetricCard
        label="Keys"
        value={metrics.totalKeys.toLocaleString()}
        subtext={`${metrics.keysWithExpiry} with TTL`}
        color="text-white"
      />
      <MetricCard
        label="Evicted"
        value={metrics.evictedKeys.toLocaleString()}
        color={metrics.evictedKeys > 0 ? 'text-yellow-400' : 'text-white'}
      />
      <MetricCard
        label="Fragmentation"
        value={metrics.memFragmentationRatio?.toFixed(2) || 'N/A'}
        color={metrics.memFragmentationRatio && metrics.memFragmentationRatio > 1.5 ? 'text-yellow-400' : 'text-white'}
      />
      <MetricCard
        label="Role"
        value={metrics.role}
        subtext={metrics.connectedSlaves > 0 ? `${metrics.connectedSlaves} replicas` : undefined}
        color="text-white"
      />
      <MetricCard
        label="Version"
        value={metrics.redisVersion}
        color="text-slate-400"
      />
      <MetricCard
        label="Uptime"
        value={formatDuration(metrics.uptimeSeconds)}
        color="text-slate-400"
      />
    </div>
  );
}

// PostgreSQL Current Metrics Component
function PostgresCurrentMetrics({ metrics }: { metrics: PostgresMetrics }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MetricCard
        label="Connections"
        value={`${metrics.activeConnections}/${metrics.maxConnections}`}
        subtext={`${metrics.idleConnections} idle`}
        color={metrics.connectionUsagePercent > 80 ? 'text-red-400' : 'text-white'}
      />
      <MetricCard
        label="Cache Hit"
        value={metrics.cacheHitRatio !== null ? `${(metrics.cacheHitRatio * 100).toFixed(1)}%` : 'N/A'}
        color={metrics.cacheHitRatio !== null && metrics.cacheHitRatio < 0.95 ? 'text-yellow-400' : 'text-green-400'}
      />
      <MetricCard
        label="Database Size"
        value={formatBytes(metrics.databaseSizeBytes)}
        color="text-white"
      />
      <MetricCard
        label="Deadlocks"
        value={metrics.deadlocks.toLocaleString()}
        color={metrics.deadlocks > 0 ? 'text-red-400' : 'text-white'}
      />
      <MetricCard
        label="Transactions"
        value={metrics.transactionsCommitted.toLocaleString()}
        subtext={`${metrics.transactionsRolledBack} rolled back`}
        color="text-white"
      />
      <MetricCard
        label="Temp Files"
        value={formatBytes(metrics.tempFilesBytes)}
        subtext={`${metrics.tempFilesCount} files`}
        color={metrics.tempFilesBytes > 0 ? 'text-yellow-400' : 'text-white'}
      />
      {metrics.tableHealth && (
        <>
          <MetricCard
            label="Tables"
            value={metrics.tableHealth.totalTables.toString()}
            color="text-white"
          />
          <MetricCard
            label="Need Vacuum"
            value={metrics.tableHealth.tablesNeedingVacuum.toString()}
            color={metrics.tableHealth.tablesNeedingVacuum > 0 ? 'text-yellow-400' : 'text-white'}
          />
        </>
      )}
      <MetricCard
        label="Version"
        value={metrics.postgresVersion}
        color="text-slate-400"
      />
      {metrics.uptimeSeconds && (
        <MetricCard
          label="Uptime"
          value={formatDuration(metrics.uptimeSeconds)}
          color="text-slate-400"
        />
      )}
    </div>
  );
}

// SQLite Current Metrics Component
function SqliteCurrentMetrics({ metrics }: { metrics: SqliteMetrics }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MetricCard
        label="File Size"
        value={formatBytes(metrics.fileSizeBytes)}
        color="text-white"
      />
      <MetricCard
        label="Pages"
        value={`${metrics.usedPages} / ${metrics.pageCount}`}
        subtext={`${metrics.freePages} free`}
        color="text-white"
      />
      <MetricCard
        label="Fragmentation"
        value={`${metrics.fragmentationPercent.toFixed(1)}%`}
        color={metrics.fragmentationPercent > 10 ? 'text-yellow-400' : 'text-white'}
      />
      <MetricCard
        label="Journal Mode"
        value={metrics.journalMode}
        color="text-white"
      />
      {metrics.walEnabled && metrics.walSizeBytes !== null && (
        <MetricCard
          label="WAL Size"
          value={formatBytes(metrics.walSizeBytes)}
          color="text-white"
        />
      )}
      <MetricCard
        label="Tables"
        value={metrics.tableCount.toString()}
        color="text-white"
      />
      <MetricCard
        label="Indexes"
        value={metrics.indexCount.toString()}
        color="text-white"
      />
      <MetricCard
        label="Integrity"
        value={metrics.integrityOk === null ? 'Unknown' : metrics.integrityOk ? 'OK' : 'Failed'}
        color={metrics.integrityOk === false ? 'text-red-400' : 'text-green-400'}
      />
    </div>
  );
}

// Metric Card Component
function MetricCard({
  label,
  value,
  subtext,
  color = 'text-white',
}: {
  label: string;
  value: string;
  subtext?: string;
  color?: string;
}) {
  return (
    <div className="bg-slate-800 rounded-lg p-3">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
      {subtext && <div className="text-xs text-slate-500">{subtext}</div>}
    </div>
  );
}

// Redis Charts Component
function RedisCharts({ metrics }: { metrics: DataStoreMetricsEntry[] }) {
  const chartData = metrics.map((m) => {
    const rm = m.metrics as RedisMetrics;
    return {
      time: format(new Date(m.collectedAt), 'HH:mm'),
      hitRate: rm.hitRate !== null ? rm.hitRate * 100 : null,
      memoryPercent: rm.memoryUsagePercent,
      opsPerSec: rm.opsPerSec,
      clients: rm.connectedClients,
    };
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <ChartCard title="Hit Rate %" data={chartData} dataKey="hitRate" color="#10B981" />
      <ChartCard title="Memory %" data={chartData} dataKey="memoryPercent" color="#3B82F6" />
      <ChartCard title="Operations/sec" data={chartData} dataKey="opsPerSec" color="#8B5CF6" />
      <ChartCard title="Connected Clients" data={chartData} dataKey="clients" color="#F59E0B" />
    </div>
  );
}

// PostgreSQL Charts Component
function PostgresCharts({ metrics }: { metrics: DataStoreMetricsEntry[] }) {
  const chartData = metrics.map((m) => {
    const pm = m.metrics as PostgresMetrics;
    return {
      time: format(new Date(m.collectedAt), 'HH:mm'),
      connections: pm.activeConnections,
      cacheHit: pm.cacheHitRatio !== null ? pm.cacheHitRatio * 100 : null,
      txCommitted: pm.transactionsCommitted,
      sizeMb: pm.databaseSizeBytes / (1024 * 1024),
    };
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <ChartCard title="Active Connections" data={chartData} dataKey="connections" color="#3B82F6" />
      <ChartCard title="Cache Hit Rate %" data={chartData} dataKey="cacheHit" color="#10B981" />
      <ChartCard title="Transactions Committed" data={chartData} dataKey="txCommitted" color="#8B5CF6" />
      <ChartCard title="Database Size (MB)" data={chartData} dataKey="sizeMb" color="#F59E0B" />
    </div>
  );
}

// SQLite Charts Component
function SqliteCharts({ metrics }: { metrics: DataStoreMetricsEntry[] }) {
  const chartData = metrics.map((m) => {
    const sm = m.metrics as SqliteMetrics;
    return {
      time: format(new Date(m.collectedAt), 'HH:mm'),
      sizeMb: sm.fileSizeBytes / (1024 * 1024),
      fragmentation: sm.fragmentationPercent,
      pages: sm.pageCount,
    };
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <ChartCard title="File Size (MB)" data={chartData} dataKey="sizeMb" color="#3B82F6" />
      <ChartCard title="Fragmentation %" data={chartData} dataKey="fragmentation" color="#F59E0B" />
      <ChartCard title="Page Count" data={chartData} dataKey="pages" color="#8B5CF6" />
    </div>
  );
}

// Chart Card Component
function ChartCard({
  title,
  data,
  dataKey,
  color,
}: {
  title: string;
  data: Array<Record<string, unknown>>;
  dataKey: string;
  color: string;
}) {
  return (
    <div className="card">
      <h4 className="text-sm font-medium text-slate-400 mb-3">{title}</h4>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="time" stroke="#64748B" tick={{ fontSize: 10 }} />
            <YAxis stroke="#64748B" tick={{ fontSize: 10 }} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1E293B', border: '1px solid #334155' }}
              labelStyle={{ color: '#94A3B8' }}
            />
            <Line
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

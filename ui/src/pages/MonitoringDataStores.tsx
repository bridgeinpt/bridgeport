import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import {
  listDataStores,
  createDataStore,
  deleteDataStore,
  testDataStoreConnection,
  collectDataStoreMetricsNow,
  listServers,
  type DataStore,
  type DataStoreInput,
  type DataStoreType,
  type Server,
} from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
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

function getTypeIcon(type: DataStoreType): string {
  switch (type) {
    case 'redis':
      return 'R';
    case 'postgres':
      return 'P';
    case 'sqlite':
      return 'S';
    default:
      return '?';
  }
}

function getTypeColor(type: DataStoreType): string {
  switch (type) {
    case 'redis':
      return 'bg-red-500/20 text-red-400';
    case 'postgres':
      return 'bg-blue-500/20 text-blue-400';
    case 'sqlite':
      return 'bg-emerald-500/20 text-emerald-400';
    default:
      return 'bg-slate-500/20 text-slate-400';
  }
}

export default function MonitoringDataStores() {
  const { selectedEnvironment, autoRefreshEnabled, setAutoRefreshEnabled } = useAppStore();
  const navigate = useNavigate();

  const [dataStores, setDataStores] = useState<DataStore[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [collecting, setCollecting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Create form state
  const [formData, setFormData] = useState<DataStoreInput>({
    name: '',
    type: 'redis',
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const fetchData = async (isRefresh = false) => {
    if (!selectedEnvironment?.id) return;
    if (!isRefresh) setLoading(true);
    try {
      const [storesResponse, serversResponse] = await Promise.all([
        listDataStores(selectedEnvironment.id),
        listServers(selectedEnvironment.id),
      ]);
      setDataStores(storesResponse.dataStores);
      setServers(serversResponse.servers);
    } finally {
      if (!isRefresh) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [selectedEnvironment?.id]);

  // Auto-refresh every 30 seconds if enabled
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const interval = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(interval);
  }, [selectedEnvironment?.id, autoRefreshEnabled]);

  const handleTestConnection = async (id: string) => {
    setTesting(id);
    try {
      await testDataStoreConnection(id);
      await fetchData(true);
    } finally {
      setTesting(null);
    }
  };

  const handleCollectNow = async (id: string) => {
    setCollecting(id);
    try {
      await collectDataStoreMetricsNow(id);
      await fetchData(true);
    } finally {
      setCollecting(null);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete data store "${name}"? This will also delete all collected metrics.`)) {
      return;
    }
    setDeleting(id);
    try {
      await deleteDataStore(id);
      await fetchData(true);
    } finally {
      setDeleting(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;

    setCreating(true);
    setCreateError(null);

    try {
      const response = await createDataStore(selectedEnvironment.id, formData);
      setShowCreateModal(false);
      setFormData({ name: '', type: 'redis' });
      navigate(`/data-stores/${response.dataStore.id}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Failed to create data store');
    } finally {
      setCreating(false);
    }
  };

  const getMetricsSummary = (ds: DataStore): string => {
    if (!ds.latestMetrics?.metrics) return 'No data';

    const m = ds.latestMetrics.metrics;

    if (ds.type === 'redis' && 'hitRate' in m) {
      const hitRate = m.hitRate !== null ? `${(m.hitRate * 100).toFixed(1)}%` : 'N/A';
      const memory = m.memoryUsagePercent !== null ? `${m.memoryUsagePercent.toFixed(1)}%` : 'N/A';
      return `Hit: ${hitRate} | Mem: ${memory} | Ops: ${m.opsPerSec}/s`;
    }

    if (ds.type === 'postgres' && 'activeConnections' in m) {
      const cacheHit = m.cacheHitRatio !== null ? `${(m.cacheHitRatio * 100).toFixed(1)}%` : 'N/A';
      return `Conn: ${m.activeConnections}/${m.maxConnections} | Cache: ${cacheHit} | Size: ${formatBytes(m.databaseSizeBytes)}`;
    }

    if (ds.type === 'sqlite' && 'fileSizeBytes' in m) {
      return `Size: ${formatBytes(m.fileSizeBytes)} | Pages: ${m.pageCount} | Frag: ${m.fragmentationPercent.toFixed(1)}%`;
    }

    return 'No data';
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <p className="text-slate-400">Select an environment to view data stores</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Monitor Redis, PostgreSQL, and SQLite data stores
        </p>
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
            onClick={() => setShowCreateModal(true)}
            className="btn btn-primary"
          >
            Add Data Store
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-slate-700 rounded" />
            ))}
          </div>
        </div>
      ) : dataStores.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-slate-400 mb-4">No data stores configured</div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn btn-primary"
          >
            Add Your First Data Store
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {dataStores.map((ds) => (
            <div key={ds.id} className="card hover:bg-slate-800/50 transition-colors">
              <div className="flex items-start gap-4">
                {/* Type Icon */}
                <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-lg font-bold ${getTypeColor(ds.type)}`}>
                  {getTypeIcon(ds.type)}
                </div>

                {/* Main Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1">
                    <Link
                      to={`/data-stores/${ds.id}`}
                      className="text-white font-medium hover:text-brand-400"
                    >
                      {ds.name}
                    </Link>
                    <span className={`px-2 py-0.5 text-xs rounded-full ${getStatusColor(ds.status)}`}>
                      {ds.status}
                    </span>
                    {!ds.enabled && (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-slate-600 text-slate-400">
                        Disabled
                      </span>
                    )}
                  </div>

                  <div className="text-sm text-slate-400 mb-2">
                    {ds.type === 'sqlite' ? (
                      <span className="font-mono">{ds.filePath}</span>
                    ) : (
                      <span className="font-mono">{ds.host}:{ds.port}</span>
                    )}
                    {ds.server && (
                      <span className="ml-2 text-slate-500">
                        via {ds.server.name}
                      </span>
                    )}
                  </div>

                  {/* Metrics Summary */}
                  <div className="text-sm text-slate-500">
                    {getMetricsSummary(ds)}
                  </div>

                  {ds.lastError && (
                    <div className="text-sm text-red-400 mt-1 truncate" title={ds.lastError}>
                      {ds.lastError}
                    </div>
                  )}
                </div>

                {/* Last Collected */}
                <div className="text-right text-sm">
                  <div className="text-slate-500">
                    {ds.lastCollectedAt
                      ? formatDistanceToNow(new Date(ds.lastCollectedAt), { addSuffix: true })
                      : 'Never'}
                  </div>
                  <div className="text-slate-600 text-xs mt-1">
                    Every {ds.collectionIntervalSec}s
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTestConnection(ds.id)}
                    disabled={testing === ds.id}
                    className="btn btn-secondary px-3 py-1 text-xs"
                    title="Test connection"
                  >
                    {testing === ds.id ? 'Testing...' : 'Test'}
                  </button>
                  <button
                    onClick={() => handleCollectNow(ds.id)}
                    disabled={collecting === ds.id || !ds.enabled}
                    className="btn btn-secondary px-3 py-1 text-xs"
                    title="Collect metrics now"
                  >
                    {collecting === ds.id ? 'Collecting...' : 'Collect'}
                  </button>
                  <button
                    onClick={() => handleDelete(ds.id, ds.name)}
                    disabled={deleting === ds.id}
                    className="btn btn-danger px-3 py-1 text-xs"
                  >
                    {deleting === ds.id ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-lg p-6 w-full max-w-lg mx-4">
            <h2 className="text-lg font-semibold text-white mb-4">Add Data Store</h2>

            <form onSubmit={handleCreate}>
              {createError && (
                <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-sm">
                  {createError}
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Name</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="input w-full"
                    placeholder="e.g., Production Redis"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm text-slate-400 mb-1">Type</label>
                  <select
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value as DataStoreType })}
                    className="input w-full"
                  >
                    <option value="redis">Redis</option>
                    <option value="postgres">PostgreSQL</option>
                    <option value="sqlite">SQLite</option>
                  </select>
                </div>

                {formData.type !== 'sqlite' && (
                  <>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <label className="block text-sm text-slate-400 mb-1">Host</label>
                        <input
                          type="text"
                          value={formData.host || ''}
                          onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                          className="input w-full"
                          placeholder="localhost"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-slate-400 mb-1">Port</label>
                        <input
                          type="number"
                          value={formData.port || (formData.type === 'redis' ? 6379 : 5432)}
                          onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) })}
                          className="input w-full"
                        />
                      </div>
                    </div>

                    {formData.type === 'postgres' && (
                      <>
                        <div>
                          <label className="block text-sm text-slate-400 mb-1">Database Name</label>
                          <input
                            type="text"
                            value={formData.databaseName || ''}
                            onChange={(e) => setFormData({ ...formData, databaseName: e.target.value })}
                            className="input w-full"
                            placeholder="postgres"
                          />
                        </div>
                        <div>
                          <label className="block text-sm text-slate-400 mb-1">Username</label>
                          <input
                            type="text"
                            value={formData.username || ''}
                            onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                            className="input w-full"
                            placeholder="postgres"
                          />
                        </div>
                      </>
                    )}

                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Password</label>
                      <input
                        type="password"
                        value={formData.password || ''}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        className="input w-full"
                        placeholder="Optional"
                      />
                    </div>

                    {formData.type === 'redis' && (
                      <div>
                        <label className="block text-sm text-slate-400 mb-1">Database Number</label>
                        <input
                          type="number"
                          value={formData.redisDb ?? 0}
                          onChange={(e) => setFormData({ ...formData, redisDb: parseInt(e.target.value) })}
                          className="input w-full"
                          min={0}
                          max={15}
                        />
                      </div>
                    )}
                  </>
                )}

                {formData.type === 'sqlite' && (
                  <>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Server</label>
                      <select
                        value={formData.serverId || ''}
                        onChange={(e) => setFormData({ ...formData, serverId: e.target.value })}
                        className="input w-full"
                        required
                      >
                        <option value="">Select a server...</option>
                        {servers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} ({s.hostname})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">File Path</label>
                      <input
                        type="text"
                        value={formData.filePath || ''}
                        onChange={(e) => setFormData({ ...formData, filePath: e.target.value })}
                        className="input w-full font-mono"
                        placeholder="/path/to/database.db"
                        required
                      />
                    </div>
                  </>
                )}
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setFormData({ name: '', type: 'redis' });
                    setCreateError(null);
                  }}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="btn btn-primary"
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

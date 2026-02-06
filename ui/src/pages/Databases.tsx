import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store.js';
import { useToast } from '../components/Toast.js';
import {
  listDatabases,
  createDatabase,
  updateDatabase,
  deleteDatabase,
  createDatabaseBackup,
  listServers,
  listSpacesBuckets,
  listDatabaseTypes,
  type Database,
  type DatabaseInput,
  type DatabaseTypeRecord,
  type Server,
} from '../lib/api.js';
import { formatDistanceToNow } from 'date-fns';
import Pagination from '../components/Pagination.js';
import { usePagination } from '../hooks/usePagination.js';
import { DatabaseIcon, EyeIcon, PencilIcon, TrashIcon } from '../components/Icons.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { EmptyState } from '../components/EmptyState.js';

const STORAGE_TYPES = [
  { value: 'local', label: 'Local Storage' },
  { value: 'spaces', label: 'DO Spaces' },
] as const;

export default function Databases() {
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const [databases, setDatabases] = useState<Database[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [databaseTypes, setDatabaseTypes] = useState<DatabaseTypeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingDb, setEditingDb] = useState<Database | null>(null);
  const [saving, setSaving] = useState(false);
  const [backingUpId, setBackingUpId] = useState<string | null>(null);
  const [spacesBuckets, setSpacesBuckets] = useState<string[]>([]);
  const [loadingBuckets, setLoadingBuckets] = useState(false);

  // Form state
  const [formData, setFormData] = useState<DatabaseInput>({
    name: '',
    type: 'postgres',
    host: '',
    port: 5432,
    databaseName: '',
    username: '',
    password: '',
    serverId: '',
    backupStorageType: 'local',
    backupLocalPath: '/var/backups',
  });

  useEffect(() => {
    if (selectedEnvironment?.id) {
      loadData();
    }
  }, [selectedEnvironment?.id]);

  const loadData = async () => {
    if (!selectedEnvironment?.id) return;
    setLoading(true);
    try {
      const [dbRes, serverRes, dbTypeRes] = await Promise.all([
        listDatabases(selectedEnvironment.id),
        listServers(selectedEnvironment.id),
        listDatabaseTypes(),
      ]);
      setDatabases(dbRes.databases);
      setServers(serverRes.servers);
      setDatabaseTypes(dbTypeRes.databaseTypes);
    } finally {
      setLoading(false);
    }
  };

  const loadBuckets = async () => {
    if (!selectedEnvironment?.id) return;
    setLoadingBuckets(true);
    try {
      const res = await listSpacesBuckets(selectedEnvironment.id);
      setSpacesBuckets(res.buckets);
    } catch {
      // Spaces may not be configured - that's ok
      setSpacesBuckets([]);
    } finally {
      setLoadingBuckets(false);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      type: 'postgres',
      host: '',
      port: 5432,
      databaseName: '',
      username: '',
      password: '',
      serverId: '',
      backupStorageType: 'local',
      backupLocalPath: '/var/backups',
    });
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;
    setCreating(true);
    try {
      const data: DatabaseInput = {
        name: formData.name,
        type: formData.type,
        databaseTypeId: formData.databaseTypeId,
        backupStorageType: formData.backupStorageType,
      };
      if (formData.host) data.host = formData.host;
      if (formData.port) data.port = formData.port;
      if (formData.databaseName) data.databaseName = formData.databaseName;
      if (formData.username) data.username = formData.username;
      if (formData.password) data.password = formData.password;
      if (formData.serverId) data.serverId = formData.serverId;
      if (formData.filePath) data.filePath = formData.filePath;
      if (formData.backupLocalPath) data.backupLocalPath = formData.backupLocalPath;
      if (formData.backupSpacesBucket) data.backupSpacesBucket = formData.backupSpacesBucket;
      if (formData.backupSpacesPrefix) data.backupSpacesPrefix = formData.backupSpacesPrefix;

      const { database } = await createDatabase(selectedEnvironment.id, data);
      setDatabases((prev) => [...prev, database]);
      setShowCreate(false);
      resetForm();
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (db: Database) => {
    if (!confirm(`Delete database "${db.name}"? This will not delete actual data.`)) return;
    try {
      await deleteDatabase(db.id);
      setDatabases((prev) => prev.filter((d) => d.id !== db.id));
      toast.success('Database deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const openEditModal = (db: Database) => {
    setEditingDb(db);
    setFormData({
      name: db.name,
      type: db.type,
      host: db.host || '',
      port: db.port || (db.type === 'mysql' ? 3306 : 5432),
      databaseName: db.databaseName || '',
      username: '',
      password: '',
      serverId: db.serverId || '',
      filePath: db.filePath || '',
      backupStorageType: db.backupStorageType || 'local',
      backupLocalPath: db.backupLocalPath || '/var/backups',
      backupSpacesBucket: db.backupSpacesBucket || '',
      backupSpacesPrefix: db.backupSpacesPrefix || '',
    });
    // Load buckets if using Spaces storage
    if (db.backupStorageType === 'spaces') {
      loadBuckets();
    }
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDb) return;
    setSaving(true);
    try {
      const data: Partial<DatabaseInput> = {
        name: formData.name,
        backupStorageType: formData.backupStorageType,
      };
      if (formData.type !== 'sqlite') {
        if (formData.host) data.host = formData.host;
        if (formData.port) data.port = formData.port;
        if (formData.databaseName) data.databaseName = formData.databaseName;
        if (formData.username) data.username = formData.username;
        if (formData.password) data.password = formData.password;
      } else {
        if (formData.serverId) data.serverId = formData.serverId;
        if (formData.filePath) data.filePath = formData.filePath;
      }
      if (formData.backupStorageType === 'local') {
        if (formData.backupLocalPath) data.backupLocalPath = formData.backupLocalPath;
      } else {
        if (formData.backupSpacesBucket) data.backupSpacesBucket = formData.backupSpacesBucket;
        if (formData.backupSpacesPrefix) data.backupSpacesPrefix = formData.backupSpacesPrefix;
      }

      const { database } = await updateDatabase(editingDb.id, data);
      setDatabases((prev) => prev.map((d) => (d.id === database.id ? database : d)));
      setEditingDb(null);
      resetForm();
      toast.success('Database updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const handleQuickBackup = async (db: Database) => {
    setBackingUpId(db.id);
    try {
      await createDatabaseBackup(db.id);
      toast.success('Backup started');
      // Refresh to show updated lastBackup
      loadData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Backup failed');
    } finally {
      setBackingUpId(null);
    }
  };

  // Pagination
  const {
    paginatedData,
    currentPage,
    totalPages,
    totalItems,
    pageSize,
    setPage,
    setPageSize,
  } = usePagination({ data: databases, defaultPageSize: 25 });

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-slate-400">Select an environment</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <LoadingSkeleton rows={3} rowHeight="h-24" headerWidth="w-48" />;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Manage database backups for {selectedEnvironment.name}
        </p>
        <button onClick={() => setShowCreate(true)} className="btn btn-primary">
          Add Database
        </button>
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-white mb-4">Add Database</h3>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="my-database"
                  className="input"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Type</label>
                <select
                  value={formData.type}
                  onChange={(e) => {
                    const selectedType = e.target.value;
                    const dbType = databaseTypes.find((t) => t.name === selectedType);
                    setFormData({
                      ...formData,
                      type: selectedType,
                      databaseTypeId: dbType?.id,
                      port: dbType?.defaultPort || undefined,
                      serverId: '',
                    });
                  }}
                  className="input"
                >
                  {databaseTypes.length > 0 ? (
                    databaseTypes.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.displayName}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="postgres">PostgreSQL</option>
                      <option value="mysql">MySQL</option>
                      <option value="sqlite">SQLite</option>
                    </>
                  )}
                </select>
              </div>

              {formData.type !== 'sqlite' && (
                <>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="col-span-2">
                      <label className="block text-sm text-slate-400 mb-1">Host</label>
                      <input
                        type="text"
                        value={formData.host}
                        onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                        placeholder="localhost"
                        className="input"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Port</label>
                      <input
                        type="number"
                        value={formData.port}
                        onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) })}
                        className="input"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Database Name</label>
                    <input
                      type="text"
                      value={formData.databaseName}
                      onChange={(e) => setFormData({ ...formData, databaseName: e.target.value })}
                      placeholder="mydb"
                      className="input"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Username</label>
                      <input
                        type="text"
                        value={formData.username}
                        onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                        className="input"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Password</label>
                      <input
                        type="password"
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        className="input"
                      />
                    </div>
                  </div>
                </>
              )}

              {formData.type === 'sqlite' && (
                <>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Server</label>
                    <select
                      value={formData.serverId}
                      onChange={(e) => setFormData({ ...formData, serverId: e.target.value })}
                      className="input"
                      required
                    >
                      <option value="">Select server...</option>
                      {servers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-slate-500 mt-1">Server where the SQLite file is located</p>
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">File Path</label>
                    <input
                      type="text"
                      value={formData.filePath}
                      onChange={(e) => setFormData({ ...formData, filePath: e.target.value })}
                      placeholder="/path/to/database.db"
                      className="input font-mono text-sm"
                    />
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm text-slate-400 mb-1">Backup Storage</label>
                <select
                  value={formData.backupStorageType}
                  onChange={(e) => {
                    const newType = e.target.value as 'local' | 'spaces';
                    setFormData({ ...formData, backupStorageType: newType });
                    if (newType === 'spaces' && spacesBuckets.length === 0) {
                      loadBuckets();
                    }
                  }}
                  className="input"
                >
                  {STORAGE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              {formData.backupStorageType === 'local' && (
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Local Path</label>
                  <input
                    type="text"
                    value={formData.backupLocalPath}
                    onChange={(e) => setFormData({ ...formData, backupLocalPath: e.target.value })}
                    placeholder="/var/backups"
                    className="input font-mono text-sm"
                  />
                </div>
              )}

              {formData.backupStorageType === 'spaces' && (
                <>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Spaces Bucket</label>
                    <div className="flex gap-2">
                      <select
                        value={formData.backupSpacesBucket || ''}
                        onChange={(e) => setFormData({ ...formData, backupSpacesBucket: e.target.value })}
                        className="input flex-1"
                      >
                        <option value="">Select a bucket...</option>
                        {spacesBuckets.map((bucket) => (
                          <option key={bucket} value={bucket}>
                            {bucket}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={loadBuckets}
                        disabled={loadingBuckets}
                        className="btn btn-ghost px-3"
                        title="Refresh bucket list"
                      >
                        {loadingBuckets ? (
                          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        )}
                      </button>
                    </div>
                    {spacesBuckets.length === 0 && !loadingBuckets && (
                      <p className="text-xs text-slate-500 mt-1">
                        No buckets found. Configure Spaces in Settings first.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Spaces Prefix</label>
                    <input
                      type="text"
                      value={formData.backupSpacesPrefix || ''}
                      onChange={(e) => setFormData({ ...formData, backupSpacesPrefix: e.target.value })}
                      placeholder="backups/staging/"
                      className="input font-mono text-sm"
                    />
                  </div>
                </>
              )}

              <div className="flex gap-2 justify-end pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    resetForm();
                  }}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={creating} className="btn btn-primary">
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingDb && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-white mb-4">Edit Database</h3>
            <form onSubmit={handleEdit} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="my-database"
                  className="input"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Type</label>
                <input
                  type="text"
                  value={editingDb.databaseType?.displayName || databaseTypes.find((t) => t.name === editingDb.type)?.displayName || editingDb.type}
                  className="input bg-slate-800"
                  disabled
                />
                <p className="text-xs text-slate-500 mt-1">Database type cannot be changed</p>
              </div>

              {editingDb.type !== 'sqlite' && (
                <>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="col-span-2">
                      <label className="block text-sm text-slate-400 mb-1">Host</label>
                      <input
                        type="text"
                        value={formData.host}
                        onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                        placeholder="localhost"
                        className="input"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Port</label>
                      <input
                        type="number"
                        value={formData.port}
                        onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) })}
                        className="input"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Database Name</label>
                    <input
                      type="text"
                      value={formData.databaseName}
                      onChange={(e) => setFormData({ ...formData, databaseName: e.target.value })}
                      placeholder="mydb"
                      className="input"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Username</label>
                      <input
                        type="text"
                        value={formData.username}
                        onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                        placeholder={editingDb.hasCredentials ? '(unchanged)' : ''}
                        className="input"
                      />
                      {editingDb.hasCredentials && (
                        <p className="text-xs text-slate-500 mt-1">Leave empty to keep current</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Password</label>
                      <input
                        type="password"
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        placeholder={editingDb.hasCredentials ? '(unchanged)' : ''}
                        className="input"
                      />
                    </div>
                  </div>
                </>
              )}

              {editingDb.type === 'sqlite' && (
                <>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Server</label>
                    <select
                      value={formData.serverId}
                      onChange={(e) => setFormData({ ...formData, serverId: e.target.value })}
                      className="input"
                      required
                    >
                      <option value="">Select server...</option>
                      {servers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-slate-500 mt-1">Server where the SQLite file is located</p>
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">File Path</label>
                    <input
                      type="text"
                      value={formData.filePath}
                      onChange={(e) => setFormData({ ...formData, filePath: e.target.value })}
                      placeholder="/path/to/database.db"
                      className="input font-mono text-sm"
                    />
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm text-slate-400 mb-1">Backup Storage</label>
                <select
                  value={formData.backupStorageType}
                  onChange={(e) => {
                    const newType = e.target.value as 'local' | 'spaces';
                    setFormData({ ...formData, backupStorageType: newType });
                    if (newType === 'spaces' && spacesBuckets.length === 0) {
                      loadBuckets();
                    }
                  }}
                  className="input"
                >
                  {STORAGE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              {formData.backupStorageType === 'local' && (
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Local Path</label>
                  <input
                    type="text"
                    value={formData.backupLocalPath}
                    onChange={(e) => setFormData({ ...formData, backupLocalPath: e.target.value })}
                    placeholder="/var/backups"
                    className="input font-mono text-sm"
                  />
                </div>
              )}

              {formData.backupStorageType === 'spaces' && (
                <>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Spaces Bucket</label>
                    <div className="flex gap-2">
                      <select
                        value={formData.backupSpacesBucket || ''}
                        onChange={(e) => setFormData({ ...formData, backupSpacesBucket: e.target.value })}
                        className="input flex-1"
                      >
                        <option value="">Select a bucket...</option>
                        {spacesBuckets.map((bucket) => (
                          <option key={bucket} value={bucket}>
                            {bucket}
                          </option>
                        ))}
                        {/* Keep current value as option if not in list */}
                        {formData.backupSpacesBucket && !spacesBuckets.includes(formData.backupSpacesBucket) && (
                          <option value={formData.backupSpacesBucket}>
                            {formData.backupSpacesBucket}
                          </option>
                        )}
                      </select>
                      <button
                        type="button"
                        onClick={loadBuckets}
                        disabled={loadingBuckets}
                        className="btn btn-ghost px-3"
                        title="Refresh bucket list"
                      >
                        {loadingBuckets ? (
                          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        )}
                      </button>
                    </div>
                    {spacesBuckets.length === 0 && !loadingBuckets && (
                      <p className="text-xs text-slate-500 mt-1">
                        No buckets found. Configure Spaces in Settings first.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Spaces Prefix</label>
                    <input
                      type="text"
                      value={formData.backupSpacesPrefix || ''}
                      onChange={(e) => setFormData({ ...formData, backupSpacesPrefix: e.target.value })}
                      placeholder="backups/staging/"
                      className="input font-mono text-sm"
                    />
                  </div>
                </>
              )}

              <div className="flex gap-2 justify-end pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setEditingDb(null);
                    resetForm();
                  }}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="btn btn-primary">
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Databases List */}
      {databases.length === 0 ? (
        <EmptyState
          icon={DatabaseIcon}
          message="No databases configured"
          description="Add a database to start managing backups"
          action={{ label: 'Add Your First Database', onClick: () => setShowCreate(true) }}
        />
      ) : (
        <div className="space-y-4">
          {paginatedData.map((db) => (
            <div key={db.id} className="panel">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-slate-800 rounded-lg">
                    <DatabaseIcon className="w-6 h-6 text-primary-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-white">{db.name}</h3>
                      <span className="badge bg-slate-700 text-slate-300 text-xs">
                        {db.databaseType?.displayName || databaseTypes.find((t) => t.name === db.type)?.displayName || db.type}
                      </span>
                    </div>
                    <p className="text-slate-400 text-sm mt-1 font-mono">
                      {db.host ? `${db.host}:${db.port}/${db.databaseName}` : db.filePath}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                      <span>{db._count?.backups || 0} backups</span>
                      <span>Storage: {STORAGE_TYPES.find((t) => t.value === db.backupStorageType)?.label}</span>
                      {db.schedule && (
                        <>
                          <span className={db.schedule.enabled ? 'text-green-400' : 'text-slate-500'}>
                            {db.schedule.enabled ? 'Scheduled' : 'Schedule disabled'}
                          </span>
                          {db.schedule.enabled && db.schedule.nextRunAt && (
                            <span className="text-slate-400">
                              Next: {formatDistanceToNow(new Date(db.schedule.nextRunAt), { addSuffix: true })}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    {/* Backup Status Row */}
                    <div className="flex items-center gap-3 mt-2">
                      {db.lastBackup ? (
                        <>
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                              db.lastBackup.status === 'completed'
                                ? 'bg-green-500/20 text-green-400'
                                : db.lastBackup.status === 'failed'
                                ? 'bg-red-500/20 text-red-400'
                                : db.lastBackup.status === 'in_progress'
                                ? 'bg-blue-500/20 text-blue-400'
                                : 'bg-slate-500/20 text-slate-400'
                            }`}
                          >
                            {db.lastBackup.status === 'completed' && (
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                            {db.lastBackup.status === 'failed' && (
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            )}
                            {db.lastBackup.status === 'in_progress' && (
                              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                            )}
                            Last backup: {db.lastBackup.status.replace('_', ' ')}
                          </span>
                          <span className="text-xs text-slate-500">
                            {formatDistanceToNow(new Date(db.lastBackup.createdAt), { addSuffix: true })}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-slate-500 italic">No backups yet</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleQuickBackup(db)}
                    disabled={backingUpId === db.id}
                    className="btn btn-primary text-sm"
                  >
                    {backingUpId === db.id ? 'Starting...' : 'Backup'}
                  </button>
                  <Link
                    to={`/databases/${db.id}`}
                    className="p-1.5 text-slate-400 hover:text-white rounded"
                    title="View"
                  >
                    <EyeIcon className="w-4 h-4" />
                  </Link>
                  <button
                    onClick={() => openEditModal(db)}
                    className="p-1.5 text-slate-400 hover:text-white rounded"
                    title="Edit"
                  >
                    <PencilIcon className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(db)}
                    className="p-1.5 text-slate-400 hover:text-red-400 rounded"
                    disabled={(db._count?.backups || 0) > 0}
                    title={(db._count?.backups || 0) > 0 ? 'Delete backups first' : 'Delete'}
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={totalItems}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      )}
    </div>
  );
}

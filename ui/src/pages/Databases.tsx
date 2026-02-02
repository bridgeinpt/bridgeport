import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import {
  listDatabases,
  createDatabase,
  updateDatabase,
  deleteDatabase,
  listDatabaseBackups,
  createDatabaseBackup,
  deleteDatabaseBackup,
  getBackupSchedule,
  setBackupSchedule,
  listServers,
  type Database,
  type DatabaseInput,
  type DatabaseBackup,
  type BackupSchedule,
  type Server,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';

const DATABASE_TYPES = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'sqlite', label: 'SQLite' },
] as const;

const STORAGE_TYPES = [
  { value: 'local', label: 'Local Storage' },
  { value: 'spaces', label: 'DO Spaces' },
] as const;

export default function Databases() {
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const [databases, setDatabases] = useState<Database[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingDb, setEditingDb] = useState<Database | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewingDb, setViewingDb] = useState<Database | null>(null);
  const [backups, setBackups] = useState<DatabaseBackup[]>([]);
  const [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [backingUp, setBackingUp] = useState(false);

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

  // Schedule form
  const [scheduleForm, setScheduleForm] = useState({
    cronExpression: '0 2 * * *',
    retentionDays: 7,
    enabled: true,
  });
  const [editingSchedule, setEditingSchedule] = useState(false);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      loadData();
    }
  }, [selectedEnvironment?.id]);

  const loadData = async () => {
    if (!selectedEnvironment?.id) return;
    setLoading(true);
    try {
      const [dbRes, serverRes] = await Promise.all([
        listDatabases(selectedEnvironment.id),
        listServers(selectedEnvironment.id),
      ]);
      setDatabases(dbRes.databases);
      setServers(serverRes.servers);
    } finally {
      setLoading(false);
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

  const viewDatabase = async (db: Database) => {
    setViewingDb(db);
    setLoadingBackups(true);
    try {
      const [backupsRes, scheduleRes] = await Promise.all([
        listDatabaseBackups(db.id),
        getBackupSchedule(db.id),
      ]);
      setBackups(backupsRes.backups);
      setSchedule(scheduleRes.schedule);
      if (scheduleRes.schedule) {
        setScheduleForm({
          cronExpression: scheduleRes.schedule.cronExpression,
          retentionDays: scheduleRes.schedule.retentionDays,
          enabled: scheduleRes.schedule.enabled,
        });
      }
    } finally {
      setLoadingBackups(false);
    }
  };

  const handleBackup = async () => {
    if (!viewingDb) return;
    setBackingUp(true);
    try {
      await createDatabaseBackup(viewingDb.id);
      // Refresh backups list
      const { backups } = await listDatabaseBackups(viewingDb.id);
      setBackups(backups);
      toast.success('Backup created');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Backup failed');
    } finally {
      setBackingUp(false);
    }
  };

  const handleDeleteBackup = async (backup: DatabaseBackup) => {
    if (!confirm(`Delete backup "${backup.filename}"?`)) return;
    try {
      await deleteDatabaseBackup(backup.id);
      setBackups((prev) => prev.filter((b) => b.id !== backup.id));
      toast.success('Backup deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const handleSaveSchedule = async () => {
    if (!viewingDb) return;
    try {
      const { schedule } = await setBackupSchedule(viewingDb.id, scheduleForm);
      setSchedule(schedule);
      setEditingSchedule(false);
      toast.success('Schedule saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save schedule');
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-8">
        <div className="card text-center py-12">
          <p className="text-slate-400">Select an environment</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-slate-700 rounded mb-8"></div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 bg-slate-800 rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Databases</h1>
          <p className="text-slate-400">
            Manage database backups for {selectedEnvironment.name}
          </p>
        </div>
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
                  onChange={(e) =>
                    setFormData({ ...formData, type: e.target.value as 'postgres' | 'mysql' | 'sqlite', serverId: '' })
                  }
                  className="input"
                >
                  {DATABASE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
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
                  onChange={(e) =>
                    setFormData({ ...formData, backupStorageType: e.target.value as 'local' | 'spaces' })
                  }
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
                  value={DATABASE_TYPES.find((t) => t.value === editingDb.type)?.label}
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
                  onChange={(e) =>
                    setFormData({ ...formData, backupStorageType: e.target.value as 'local' | 'spaces' })
                  }
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
                    <input
                      type="text"
                      value={formData.backupSpacesBucket}
                      onChange={(e) => setFormData({ ...formData, backupSpacesBucket: e.target.value })}
                      placeholder="my-bucket"
                      className="input"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Spaces Prefix</label>
                    <input
                      type="text"
                      value={formData.backupSpacesPrefix}
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

      {/* Database Detail Modal */}
      {viewingDb && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-3xl p-6 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-white">{viewingDb.name}</h3>
                <p className="text-sm text-slate-400">
                  {DATABASE_TYPES.find((t) => t.value === viewingDb.type)?.label} •{' '}
                  {viewingDb.host || viewingDb.filePath}
                </p>
              </div>
              <button onClick={() => setViewingDb(null)} className="text-slate-400 hover:text-white">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex gap-2 mb-4">
              <button onClick={handleBackup} disabled={backingUp} className="btn btn-primary">
                {backingUp ? 'Backing up...' : 'Create Backup'}
              </button>
              <button onClick={() => setEditingSchedule(!editingSchedule)} className="btn btn-secondary">
                {schedule ? 'Edit Schedule' : 'Set Schedule'}
              </button>
            </div>

            {/* Schedule Section */}
            {(editingSchedule || schedule) && (
              <div className="mb-4 p-4 bg-slate-800/50 rounded-lg">
                <h4 className="text-sm font-medium text-white mb-3">Backup Schedule</h4>
                {editingSchedule ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <label className="block text-xs text-slate-400 mb-1">Cron Expression</label>
                        <input
                          type="text"
                          value={scheduleForm.cronExpression}
                          onChange={(e) =>
                            setScheduleForm({ ...scheduleForm, cronExpression: e.target.value })
                          }
                          placeholder="0 2 * * *"
                          className="input text-sm font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Retention Days</label>
                        <input
                          type="number"
                          value={scheduleForm.retentionDays}
                          onChange={(e) =>
                            setScheduleForm({ ...scheduleForm, retentionDays: parseInt(e.target.value) })
                          }
                          className="input text-sm"
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="scheduleEnabled"
                        checked={scheduleForm.enabled}
                        onChange={(e) => setScheduleForm({ ...scheduleForm, enabled: e.target.checked })}
                        className="rounded bg-slate-700 border-slate-600 text-primary-500"
                      />
                      <label htmlFor="scheduleEnabled" className="text-sm text-slate-300">
                        Enabled
                      </label>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleSaveSchedule} className="btn btn-primary text-sm">
                        Save Schedule
                      </button>
                      <button onClick={() => setEditingSchedule(false)} className="btn btn-ghost text-sm">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : schedule ? (
                  <div className="text-sm">
                    <p className="text-slate-300">
                      <span className="text-slate-500">Schedule:</span>{' '}
                      <code className="font-mono">{schedule.cronExpression}</code>
                    </p>
                    <p className="text-slate-300">
                      <span className="text-slate-500">Retention:</span> {schedule.retentionDays} days
                    </p>
                    <p className="text-slate-300">
                      <span className="text-slate-500">Status:</span>{' '}
                      <span className={schedule.enabled ? 'text-green-400' : 'text-slate-500'}>
                        {schedule.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </p>
                  </div>
                ) : null}
              </div>
            )}

            {/* Backups List */}
            <div className="flex-1 overflow-y-auto">
              <h4 className="text-sm font-medium text-white mb-3">Backups</h4>
              {loadingBackups ? (
                <div className="text-slate-400">Loading backups...</div>
              ) : backups.length === 0 ? (
                <div className="text-slate-400 text-center py-8">No backups yet</div>
              ) : (
                <div className="space-y-2">
                  {backups.map((backup) => (
                    <div
                      key={backup.id}
                      className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg"
                    >
                      <div>
                        <p className="text-sm text-white font-mono">{backup.filename}</p>
                        <div className="flex items-center gap-3 text-xs text-slate-400 mt-1">
                          <span>{formatBytes(backup.size)}</span>
                          <span>{backup.type}</span>
                          <span
                            className={
                              backup.status === 'completed'
                                ? 'text-green-400'
                                : backup.status === 'failed'
                                ? 'text-red-400'
                                : 'text-yellow-400'
                            }
                          >
                            {backup.status}
                          </span>
                          <span>
                            {format(new Date(backup.createdAt), 'MMM d, yyyy h:mm a')}
                          </span>
                        </div>
                        {backup.error && (
                          <p className="text-xs text-red-400 mt-1">{backup.error}</p>
                        )}
                      </div>
                      <button
                        onClick={() => handleDeleteBackup(backup)}
                        className="btn btn-ghost text-sm text-red-400 hover:text-red-300"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Databases List */}
      {databases.length === 0 ? (
        <div className="card text-center py-12">
          <DatabaseIcon className="w-12 h-12 text-slate-500 mx-auto mb-4" />
          <p className="text-slate-400 mb-4">No databases configured</p>
          <p className="text-slate-500 text-sm mb-4">
            Add a database to start managing backups
          </p>
          <button onClick={() => setShowCreate(true)} className="btn btn-primary">
            Add Your First Database
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {databases.map((db) => (
            <div key={db.id} className="card">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-slate-800 rounded-lg">
                    <DatabaseIcon className="w-6 h-6 text-primary-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-white">{db.name}</h3>
                      <span className="badge bg-slate-700 text-slate-300 text-xs">
                        {DATABASE_TYPES.find((t) => t.value === db.type)?.label}
                      </span>
                    </div>
                    <p className="text-slate-400 text-sm mt-1 font-mono">
                      {db.host ? `${db.host}:${db.port}/${db.databaseName}` : db.filePath}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                      <span>{db._count?.backups || 0} backups</span>
                      <span>Storage: {STORAGE_TYPES.find((t) => t.value === db.backupStorageType)?.label}</span>
                      <span>
                        Updated {formatDistanceToNow(new Date(db.updatedAt), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => viewDatabase(db)} className="btn btn-ghost text-sm">
                    View
                  </button>
                  <button onClick={() => openEditModal(db)} className="btn btn-ghost text-sm">
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(db)}
                    className="btn btn-ghost text-sm text-red-400 hover:text-red-300"
                    disabled={(db._count?.backups || 0) > 0}
                    title={(db._count?.backups || 0) > 0 ? 'Delete backups first' : ''}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DatabaseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
      />
    </svg>
  );
}

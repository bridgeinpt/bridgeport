import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import {
  getDatabase,
  updateDatabase,
  listDatabaseBackups,
  createDatabaseBackup,
  deleteDatabaseBackup,
  getBackupSchedule,
  setBackupSchedule,
  deleteBackupSchedule,
  listSpacesBuckets,
  getBackupDownloadUrl,
  listServers,
  testDatabaseConnection,
  updateDatabaseMonitoring,
  type Database,
  type DatabaseInput,
  type DatabaseBackup,
  type BackupSchedule,
  type PgDumpOptions,
  type Server,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';
import Pagination from '../components/Pagination';


const BACKUP_FORMATS = [
  { value: 'plain', label: 'Plain SQL (.sql)', description: 'Standard SQL dump, human-readable' },
  { value: 'custom', label: 'Custom (.dump)', description: 'Compressed, supports parallel restore' },
  { value: 'tar', label: 'Tar Archive (.tar)', description: 'Archive format, individual files' },
] as const;

const COMPRESSION_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'gzip', label: 'Gzip' },
] as const;

const PG_DUMP_OPTIONS = [
  { key: 'noOwner', label: 'No Owner', description: 'Skip ownership commands' },
  { key: 'clean', label: 'Clean', description: 'Drop objects before creating' },
  { key: 'ifExists', label: 'If Exists', description: 'Add IF EXISTS to DROP commands' },
  { key: 'schemaOnly', label: 'Schema Only', description: 'Structure without data' },
  { key: 'dataOnly', label: 'Data Only', description: 'Data without structure' },
] as const;

interface BackupError {
  message: string;
  step: 'connect' | 'dump' | 'upload';
  stderr?: string;
  exitCode?: number;
}

function parseBackupError(error: string | null): BackupError | string | null {
  if (!error) return null;
  try {
    return JSON.parse(error) as BackupError;
  } catch {
    return error;
  }
}

export default function DatabaseDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { selectedEnvironment, setBreadcrumbName } = useAppStore();
  const toast = useToast();

  const [database, setDatabase] = useState<Database | null>(null);
  const [backups, setBackups] = useState<DatabaseBackup[]>([]);
  const [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [allowDownload, setAllowDownload] = useState(false);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [totalBackups, setTotalBackups] = useState(0);
  const pageSize = 10;

  // Edit states
  const [editingConnection, setEditingConnection] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(false);

  // Servers list for SQLite database selection
  const [servers, setServers] = useState<Server[]>([]);

  // Form states
  const [connectionForm, setConnectionForm] = useState({
    name: '',
    host: '',
    port: 5432,
    databaseName: '',
    username: '',
    password: '',
    serverId: '' as string | null,
    filePath: '',
  });

  const [configForm, setConfigForm] = useState({
    backupFormat: 'plain' as 'plain' | 'custom' | 'tar',
    backupCompression: 'none' as 'none' | 'gzip',
    backupCompressionLevel: 6,
    pgDumpOptions: {} as PgDumpOptions,
    pgDumpTimeoutSec: 300,
    backupStorageType: 'local' as 'local' | 'spaces',
    backupLocalPath: '/var/backups',
    backupSpacesBucket: '',
    backupSpacesPrefix: '',
  });

  const [scheduleForm, setScheduleForm] = useState({
    cronExpression: '0 2 * * *',
    retentionDays: 7,
    enabled: true,
  });

  const [spacesBuckets, setSpacesBuckets] = useState<string[]>([]);
  const [loadingBuckets, setLoadingBuckets] = useState(false);

  // Polling for in-progress backups
  const [pollingBackupId, setPollingBackupId] = useState<string | null>(null);

  // Monitoring state
  const [monitoringEnabled, setMonitoringEnabled] = useState(true);
  const [collectionInterval, setCollectionInterval] = useState(300);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; latencyMs: number | null; serverVersion?: string; error?: string } | null>(null);
  const [savingMonitoring, setSavingMonitoring] = useState(false);

  const loadDatabase = useCallback(async () => {
    if (!id) return;
    try {
      const { database: db } = await getDatabase(id);
      setDatabase(db);
      setBreadcrumbName(id, db.name);
      setConnectionForm({
        name: db.name,
        host: db.host || '',
        port: db.port || 5432,
        databaseName: db.databaseName || '',
        username: '',
        password: '',
        serverId: db.serverId,
        filePath: db.filePath || '',
      });
      setConfigForm({
        backupFormat: db.backupFormat || 'plain',
        backupCompression: db.backupCompression || 'none',
        backupCompressionLevel: db.backupCompressionLevel || 6,
        pgDumpOptions: db.pgDumpOptions || {},
        pgDumpTimeoutSec: Math.round((db.pgDumpTimeoutMs || 300000) / 1000),
        backupStorageType: db.backupStorageType || 'local',
        backupLocalPath: db.backupLocalPath || '/var/backups',
        backupSpacesBucket: db.backupSpacesBucket || '',
        backupSpacesPrefix: db.backupSpacesPrefix || '',
      });
      // Set monitoring state from database
      setMonitoringEnabled(db.monitoringEnabled ?? true);
      setCollectionInterval(db.collectionIntervalSec ?? 300);
    } catch {
      toast.error('Failed to load database');
      navigate('/databases');
    }
  }, [id, navigate, toast]);

  const loadServers = useCallback(async () => {
    if (!selectedEnvironment?.id) return;
    try {
      const { servers: serverList } = await listServers(selectedEnvironment.id);
      setServers(serverList);
    } catch {
      setServers([]);
    }
  }, [selectedEnvironment?.id]);

  const loadBackups = useCallback(async (page = 1) => {
    if (!id) return;
    setLoadingBackups(true);
    try {
      const offset = (page - 1) * pageSize;
      const { backups: backupList, total, allowDownload: canDownload } = await listDatabaseBackups(id, pageSize, offset);
      setBackups(backupList);
      setTotalBackups(total);
      setAllowDownload(canDownload);

      // Check if any backup is in progress
      const inProgress = backupList.find(b => b.status === 'in_progress' || b.status === 'pending');
      if (inProgress) {
        setPollingBackupId(inProgress.id);
      } else {
        setPollingBackupId(null);
      }
    } finally {
      setLoadingBackups(false);
    }
  }, [id, pageSize]);

  const loadSchedule = useCallback(async () => {
    if (!id) return;
    try {
      const { schedule: sched } = await getBackupSchedule(id);
      setSchedule(sched);
      if (sched) {
        setScheduleForm({
          cronExpression: sched.cronExpression,
          retentionDays: sched.retentionDays,
          enabled: sched.enabled,
        });
      }
    } catch {
      // Schedule may not exist
    }
  }, [id]);

  const loadBuckets = async () => {
    if (!selectedEnvironment?.id) return;
    setLoadingBuckets(true);
    try {
      const res = await listSpacesBuckets(selectedEnvironment.id);
      setSpacesBuckets(res.buckets);
    } catch {
      setSpacesBuckets([]);
    } finally {
      setLoadingBuckets(false);
    }
  };

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([loadDatabase(), loadBackups(1), loadSchedule(), loadServers()]);
      setLoading(false);
    };
    loadData();
  }, [loadDatabase, loadBackups, loadSchedule, loadServers]);

  // Poll for backup progress
  useEffect(() => {
    if (!pollingBackupId) return;

    const interval = setInterval(() => {
      loadBackups(currentPage);
    }, 2000);

    return () => clearInterval(interval);
  }, [pollingBackupId, currentPage, loadBackups]);

  const handleBackup = async () => {
    if (!id) return;
    setBackingUp(true);
    try {
      await createDatabaseBackup(id);
      toast.success('Backup started');
      await loadBackups(1);
      setCurrentPage(1);
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
      setBackups(prev => prev.filter(b => b.id !== backup.id));
      setTotalBackups(prev => prev - 1);
      toast.success('Backup deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const handleDownload = async (backup: DatabaseBackup) => {
    try {
      const { downloadUrl } = await getBackupDownloadUrl(backup.id);
      window.open(downloadUrl, '_blank');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Download failed');
    }
  };

  const handleSaveConnection = async () => {
    if (!id || !database) return;
    setSaving(true);
    try {
      const data: Partial<DatabaseInput> = {};
      if (connectionForm.name && connectionForm.name !== database.name) {
        data.name = connectionForm.name;
      }
      if (database.type === 'sqlite') {
        data.serverId = connectionForm.serverId || undefined;
        data.filePath = connectionForm.filePath;
      } else {
        if (connectionForm.host) data.host = connectionForm.host;
        if (connectionForm.port) data.port = connectionForm.port;
        if (connectionForm.databaseName) data.databaseName = connectionForm.databaseName;
        if (connectionForm.username) data.username = connectionForm.username;
        if (connectionForm.password) data.password = connectionForm.password;
      }

      const { database: updated } = await updateDatabase(id, data);
      setDatabase(updated);
      setBreadcrumbName(id, updated.name);
      setEditingConnection(false);
      toast.success('Connection info saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!id || !database) return;
    setSaving(true);
    try {
      const data: Partial<DatabaseInput> = {
        backupFormat: configForm.backupFormat,
        backupCompression: configForm.backupCompression,
        backupCompressionLevel: configForm.backupCompressionLevel,
        pgDumpOptions: configForm.pgDumpOptions,
        pgDumpTimeoutMs: configForm.pgDumpTimeoutSec * 1000,
        backupStorageType: configForm.backupStorageType,
      };
      if (configForm.backupStorageType === 'local') {
        data.backupLocalPath = configForm.backupLocalPath;
      } else {
        data.backupSpacesBucket = configForm.backupSpacesBucket;
        data.backupSpacesPrefix = configForm.backupSpacesPrefix;
      }

      const { database: updated } = await updateDatabase(id, data);
      setDatabase(updated);
      setEditingConfig(false);
      toast.success('Configuration saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSchedule = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const { schedule: sched } = await setBackupSchedule(id, scheduleForm);
      setSchedule(sched);
      setEditingSchedule(false);
      toast.success('Schedule saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleSchedule = async () => {
    if (!id || !schedule) return;
    try {
      const { schedule: sched } = await setBackupSchedule(id, {
        ...scheduleForm,
        enabled: !schedule.enabled,
      });
      setSchedule(sched);
      setScheduleForm(prev => ({ ...prev, enabled: sched.enabled }));
      toast.success(sched.enabled ? 'Schedule enabled' : 'Schedule disabled');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to toggle schedule');
    }
  };

  const handleDeleteSchedule = async () => {
    if (!id || !confirm('Delete backup schedule?')) return;
    try {
      await deleteBackupSchedule(id);
      setSchedule(null);
      setEditingSchedule(false);
      toast.success('Schedule deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatDuration = (seconds: number | null) => {
    if (seconds === null) return '--';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 w-64 bg-slate-700 rounded mb-4"></div>
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-32 bg-slate-800 rounded-lg"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!database) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-slate-400">Database not found</p>
          <Link to="/databases" className="btn btn-primary mt-4">
            Back to Databases
          </Link>
        </div>
      </div>
    );
  }

  const totalPages = Math.ceil(totalBackups / pageSize);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link to="/databases" className="text-slate-400 hover:text-white">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-white">{database.name}</span>
              <span className="badge bg-slate-700 text-slate-300">
                {database.databaseType?.displayName || database.type}
              </span>
            </div>
            <p className="text-slate-400 font-mono text-sm mt-1">
              {database.host ? `${database.host}:${database.port}/${database.databaseName}` : database.filePath}
            </p>
          </div>
        </div>
        {database.databaseType?.hasBackupCommand !== false && (
        <div className="flex gap-2">
          <button
            onClick={handleBackup}
            disabled={backingUp}
            className="btn btn-primary"
          >
            {backingUp ? 'Starting...' : 'Backup Now'}
          </button>
        </div>
        )}
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Connection Info */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Connection Info</h3>
            {!editingConnection && (
              <button
                onClick={() => setEditingConnection(true)}
                className="btn btn-ghost text-sm"
              >
                Edit
              </button>
            )}
          </div>

          {editingConnection ? (
            <div className="space-y-4">
              <div>
                <label className="label">Name</label>
                <input
                  type="text"
                  value={connectionForm.name}
                  onChange={e => setConnectionForm({ ...connectionForm, name: e.target.value })}
                  placeholder="my-database"
                  className="input"
                />
              </div>
              {database.type === 'sqlite' ? (
                <>
                  <div>
                    <label className="label">Server</label>
                    <select
                      value={connectionForm.serverId || ''}
                      onChange={e => setConnectionForm({ ...connectionForm, serverId: e.target.value || null })}
                      className="input"
                    >
                      <option value="">Select server...</option>
                      {servers.map(server => (
                        <option key={server.id} value={server.id}>{server.name}</option>
                      ))}
                    </select>
                    <p className="help-text">Server to SSH into for SQLite backups</p>
                  </div>
                  <div>
                    <label className="label">File Path</label>
                    <input
                      type="text"
                      value={connectionForm.filePath}
                      onChange={e => setConnectionForm({ ...connectionForm, filePath: e.target.value })}
                      placeholder="/path/to/database.db"
                      className="input font-mono text-sm"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="col-span-2">
                      <label className="label">Host</label>
                      <input
                        type="text"
                        value={connectionForm.host}
                        onChange={e => setConnectionForm({ ...connectionForm, host: e.target.value })}
                        placeholder="localhost"
                        className="input"
                      />
                    </div>
                    <div>
                      <label className="label">Port</label>
                      <input
                        type="number"
                        value={connectionForm.port}
                        onChange={e => setConnectionForm({ ...connectionForm, port: parseInt(e.target.value) })}
                        className="input"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="label">Database Name</label>
                    <input
                      type="text"
                      value={connectionForm.databaseName}
                      onChange={e => setConnectionForm({ ...connectionForm, databaseName: e.target.value })}
                      placeholder="mydb"
                      className="input"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Username</label>
                      <input
                        type="text"
                        value={connectionForm.username}
                        onChange={e => setConnectionForm({ ...connectionForm, username: e.target.value })}
                        className="input"
                        placeholder={database.hasCredentials ? '(unchanged)' : ''}
                      />
                    </div>
                    <div>
                      <label className="label">Password</label>
                      <input
                        type="password"
                        value={connectionForm.password}
                        onChange={e => setConnectionForm({ ...connectionForm, password: e.target.value })}
                        className="input"
                        placeholder={database.hasCredentials ? '(unchanged)' : ''}
                      />
                    </div>
                  </div>
                </>
              )}
              <div className="flex gap-2 pt-2">
                <button onClick={handleSaveConnection} disabled={saving} className="btn btn-primary">
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setEditingConnection(false);
                    setConnectionForm({
                      name: database.name,
                      host: database.host || '',
                      port: database.port || 5432,
                      databaseName: database.databaseName || '',
                      username: '',
                      password: '',
                      serverId: database.serverId,
                      filePath: database.filePath || '',
                    });
                  }}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <dl className="space-y-3 text-sm">
                {database.type !== 'sqlite' ? (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-slate-400">Host</dt>
                      <dd className="text-white font-mono">{database.host || '--'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-400">Port</dt>
                      <dd className="text-white">{database.port || '--'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-400">Database</dt>
                      <dd className="text-white font-mono">{database.databaseName || '--'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-400">Credentials</dt>
                      <dd className="text-white">{database.hasCredentials ? 'Configured' : 'Not set'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-400">Server</dt>
                      <dd className="text-slate-500">None (direct connection)</dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-slate-400">File Path</dt>
                      <dd className="text-white font-mono text-xs">{database.filePath || '--'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-400">Server</dt>
                      <dd className="text-white">
                        {database.serverId
                          ? servers.find(s => s.id === database.serverId)?.name || 'Unknown'
                          : <span className="text-yellow-400">Not configured</span>}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
              <div className="pt-2 border-t border-slate-700">
                <div className="flex items-center justify-between">
                  <button
                    onClick={async () => {
                      if (!selectedEnvironment?.id || !id) return;
                      setTestingConnection(true);
                      setTestResult(null);
                      try {
                        const result = await testDatabaseConnection(selectedEnvironment.id, id);
                        setTestResult(result);
                      } catch (error) {
                        setTestResult({ success: false, latencyMs: null, error: error instanceof Error ? error.message : 'Connection test failed' });
                      } finally {
                        setTestingConnection(false);
                      }
                    }}
                    disabled={testingConnection}
                    className="btn btn-secondary text-sm"
                  >
                    {testingConnection ? 'Testing...' : 'Test Connection'}
                  </button>
                  {testResult && (
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${testResult.success ? 'bg-green-400' : 'bg-red-400'}`} />
                      {testResult.success ? (
                        <span className="text-xs text-slate-400">
                          {testResult.latencyMs}ms
                          {testResult.serverVersion && (
                            <span className="ml-1 text-slate-500">({testResult.serverVersion.split(' ').slice(0, 2).join(' ')})</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-red-400">{testResult.error}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Monitoring Card */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Monitoring</h3>
            <Link
              to="/monitoring/databases"
              className="btn btn-ghost text-sm"
            >
              View Metrics
            </Link>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-white">Enable Monitoring</p>
                <p className="text-xs text-slate-500">Collect database metrics on a schedule</p>
              </div>
              <button
                onClick={async () => {
                  if (!selectedEnvironment?.id || !id) return;
                  setSavingMonitoring(true);
                  try {
                    await updateDatabaseMonitoring(selectedEnvironment.id, id, { monitoringEnabled: !monitoringEnabled });
                    setMonitoringEnabled(!monitoringEnabled);
                    toast.success(monitoringEnabled ? 'Monitoring disabled' : 'Monitoring enabled');
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Failed to update monitoring');
                  } finally {
                    setSavingMonitoring(false);
                  }
                }}
                disabled={savingMonitoring}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  monitoringEnabled
                    ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                    : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                }`}
              >
                {monitoringEnabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Collection Interval</label>
              <select
                value={collectionInterval}
                onChange={async (e) => {
                  if (!selectedEnvironment?.id || !id) return;
                  const newInterval = parseInt(e.target.value);
                  setSavingMonitoring(true);
                  try {
                    await updateDatabaseMonitoring(selectedEnvironment.id, id, { collectionIntervalSec: newInterval });
                    setCollectionInterval(newInterval);
                    toast.success('Collection interval updated');
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Failed to update interval');
                  } finally {
                    setSavingMonitoring(false);
                  }
                }}
                disabled={savingMonitoring}
                className="input w-48"
              >
                <option value={60}>1 minute</option>
                <option value={300}>5 minutes</option>
                <option value={900}>15 minutes</option>
                <option value={1800}>30 minutes</option>
                <option value={3600}>1 hour</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Backup Configuration + Schedule Row */}
      {database.databaseType?.hasBackupCommand !== false && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Backup Configuration */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Backup Configuration</h3>
            {!editingConfig && (
              <button
                onClick={() => {
                  setEditingConfig(true);
                  if (configForm.backupStorageType === 'spaces') loadBuckets();
                }}
                className="btn btn-ghost text-sm"
              >
                Edit
              </button>
            )}
          </div>

          {editingConfig ? (
            <div className="space-y-4">
              {/* Storage */}
              <div>
                <label className="block text-sm text-slate-400 mb-1">Storage</label>
                <select
                  value={configForm.backupStorageType}
                  onChange={e => {
                    const newType = e.target.value as 'local' | 'spaces';
                    setConfigForm({ ...configForm, backupStorageType: newType });
                    if (newType === 'spaces') loadBuckets();
                  }}
                  className="input"
                >
                  <option value="local">Local Storage</option>
                  <option value="spaces">DO Spaces</option>
                </select>
              </div>

              {configForm.backupStorageType === 'local' ? (
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Local Path</label>
                  <input
                    type="text"
                    value={configForm.backupLocalPath}
                    onChange={e => setConfigForm({ ...configForm, backupLocalPath: e.target.value })}
                    className="input font-mono text-sm"
                  />
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Bucket</label>
                    <select
                      value={configForm.backupSpacesBucket}
                      onChange={e => setConfigForm({ ...configForm, backupSpacesBucket: e.target.value })}
                      className="input"
                      disabled={loadingBuckets}
                    >
                      <option value="">Select bucket...</option>
                      {spacesBuckets.map(bucket => (
                        <option key={bucket} value={bucket}>{bucket}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Prefix</label>
                    <input
                      type="text"
                      value={configForm.backupSpacesPrefix}
                      onChange={e => setConfigForm({ ...configForm, backupSpacesPrefix: e.target.value })}
                      placeholder="{environment}/{name}/"
                      className="input font-mono text-sm"
                    />
                  </div>
                </>
              )}

              {/* Format (Postgres only) */}
              {database.type === 'postgres' && (
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Format</label>
                  <select
                    value={configForm.backupFormat}
                    onChange={e => setConfigForm({ ...configForm, backupFormat: e.target.value as 'plain' | 'custom' | 'tar' })}
                    className="input"
                  >
                    {BACKUP_FORMATS.map(f => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Compression (for plain format) */}
              {(database.type !== 'postgres' || configForm.backupFormat === 'plain') && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Compression</label>
                    <select
                      value={configForm.backupCompression}
                      onChange={e => setConfigForm({ ...configForm, backupCompression: e.target.value as 'none' | 'gzip' })}
                      className="input"
                    >
                      {COMPRESSION_OPTIONS.map(c => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                  </div>
                  {configForm.backupCompression === 'gzip' && (
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Level (1-9)</label>
                      <input
                        type="number"
                        min={1}
                        max={9}
                        value={configForm.backupCompressionLevel}
                        onChange={e => setConfigForm({ ...configForm, backupCompressionLevel: parseInt(e.target.value) || 6 })}
                        className="input"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* pg_dump options (Postgres only) */}
              {database.type === 'postgres' && (
                <div>
                  <label className="block text-sm text-slate-400 mb-2">pg_dump Options</label>
                  <div className="space-y-2">
                    {PG_DUMP_OPTIONS.map(opt => (
                      <label key={opt.key} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={!!configForm.pgDumpOptions[opt.key as keyof PgDumpOptions]}
                          onChange={e => setConfigForm({
                            ...configForm,
                            pgDumpOptions: {
                              ...configForm.pgDumpOptions,
                              [opt.key]: e.target.checked,
                            },
                          })}
                          className="rounded bg-slate-700 border-slate-600 text-primary-500"
                        />
                        <span className="text-white">{opt.label}</span>
                        <span className="text-slate-500">- {opt.description}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Backup Timeout (Postgres only) */}
              {database.type === 'postgres' && (
                <div>
                  <label className="block text-sm text-slate-400 mb-1">
                    Backup Timeout <span className="text-slate-500">(seconds)</span>
                  </label>
                  <input
                    type="number"
                    min={30}
                    max={3600}
                    value={configForm.pgDumpTimeoutSec}
                    onChange={e => setConfigForm({ ...configForm, pgDumpTimeoutSec: parseInt(e.target.value) || 300 })}
                    className="input w-32"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Max time for pg_dump execution (default: 300s / 5 min)
                  </p>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button onClick={handleSaveConfig} disabled={saving} className="btn btn-primary">
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setEditingConfig(false)} className="btn btn-ghost">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-400">Storage</dt>
                <dd className="text-white">
                  {database.backupStorageType === 'local' ? 'Local' : 'DO Spaces'}
                </dd>
              </div>
              {database.backupStorageType === 'local' ? (
                <div className="flex justify-between">
                  <dt className="text-slate-400">Path</dt>
                  <dd className="text-white font-mono text-xs">{database.backupLocalPath || '/var/backups'}</dd>
                </div>
              ) : (
                <>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Bucket</dt>
                    <dd className="text-white font-mono">{database.backupSpacesBucket || '--'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Prefix</dt>
                    <dd className="text-white font-mono text-xs">{database.backupSpacesPrefix || '(root)'}</dd>
                  </div>
                </>
              )}
              {database.type === 'postgres' && (
                <div className="flex justify-between">
                  <dt className="text-slate-400">Format</dt>
                  <dd className="text-white">
                    {BACKUP_FORMATS.find(f => f.value === database.backupFormat)?.label || 'Plain SQL'}
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-slate-400">Compression</dt>
                <dd className="text-white">
                  {database.backupCompression === 'gzip' ? `Gzip (level ${database.backupCompressionLevel})` : 'None'}
                </dd>
              </div>
              {database.type === 'postgres' && database.pgDumpOptions && Object.keys(database.pgDumpOptions).some(k => database.pgDumpOptions![k as keyof PgDumpOptions]) && (
                <div>
                  <dt className="text-slate-400 mb-1">pg_dump Options</dt>
                  <dd className="flex flex-wrap gap-1">
                    {PG_DUMP_OPTIONS.filter(opt => database.pgDumpOptions![opt.key as keyof PgDumpOptions]).map(opt => (
                      <span key={opt.key} className="px-2 py-0.5 bg-slate-700 rounded text-xs text-white">
                        {opt.label}
                      </span>
                    ))}
                  </dd>
                </div>
              )}
              {database.type === 'postgres' && (
                <div className="flex justify-between">
                  <dt className="text-slate-400">Backup Timeout</dt>
                  <dd className="text-white">{Math.round(database.pgDumpTimeoutMs / 1000)}s</dd>
                </div>
              )}
            </dl>
          )}
        </div>

        {/* Schedule Card */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Backup Schedule</h3>
            {!editingSchedule && (
              <button
                onClick={() => setEditingSchedule(true)}
                className="btn btn-ghost text-sm"
              >
                {schedule ? 'Edit' : 'Set Schedule'}
              </button>
            )}
          </div>

          {editingSchedule ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Cron Expression</label>
                <input
                  type="text"
                  value={scheduleForm.cronExpression}
                  onChange={e => setScheduleForm({ ...scheduleForm, cronExpression: e.target.value })}
                  placeholder="0 2 * * *"
                  className="input font-mono"
                />
                <p className="text-xs text-slate-500 mt-1">e.g., "0 2 * * *" = daily at 2am</p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Retention Days</label>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={scheduleForm.retentionDays}
                  onChange={e => setScheduleForm({ ...scheduleForm, retentionDays: parseInt(e.target.value) || 7 })}
                  className="input"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="scheduleEnabled"
                  checked={scheduleForm.enabled}
                  onChange={e => setScheduleForm({ ...scheduleForm, enabled: e.target.checked })}
                  className="rounded bg-slate-700 border-slate-600 text-primary-500"
                />
                <label htmlFor="scheduleEnabled" className="text-sm text-slate-300">Enabled</label>
              </div>
              <div className="flex gap-2">
                <button onClick={handleSaveSchedule} disabled={saving} className="btn btn-primary">
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setEditingSchedule(false)} className="btn btn-ghost">
                  Cancel
                </button>
                {schedule && (
                  <button onClick={handleDeleteSchedule} className="btn btn-ghost text-red-400 hover:text-red-300">
                    Delete Schedule
                  </button>
                )}
              </div>
            </div>
          ) : schedule ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-slate-400 text-sm">Status</span>
                <button
                  onClick={handleToggleSchedule}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    schedule.enabled
                      ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                      : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                  }`}
                >
                  {schedule.enabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Cron</span>
                <code className="font-mono text-white bg-slate-800 px-2 py-0.5 rounded text-xs">
                  {schedule.cronExpression}
                </code>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Retention</span>
                <span className="text-white">{schedule.retentionDays} days</span>
              </div>
              {schedule.lastRunAt && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-400">Last run</span>
                  <span className="text-white">{formatDistanceToNow(new Date(schedule.lastRunAt), { addSuffix: true })}</span>
                </div>
              )}
              {schedule.nextRunAt && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-400">Next run</span>
                  <span className="text-white">{formatDistanceToNow(new Date(schedule.nextRunAt), { addSuffix: true })}</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-slate-400 text-sm">No schedule configured</p>
          )}
        </div>
      </div>
      )}

      {/* Backups Table */}
      {database.databaseType?.hasBackupCommand !== false && (
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">
            Backups
            {totalBackups > 0 && <span className="text-slate-400 font-normal ml-2">({totalBackups})</span>}
          </h3>
          {loadingBackups && <span className="text-slate-400 text-sm">Refreshing...</span>}
        </div>

        {backups.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-slate-400">No backups yet</p>
            <button onClick={handleBackup} disabled={backingUp} className="btn btn-primary mt-4">
              Create First Backup
            </button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-slate-700">
                    <th className="pb-3 font-medium">Filename</th>
                    <th className="pb-3 font-medium">Size</th>
                    <th className="pb-3 font-medium">Status</th>
                    <th className="pb-3 font-medium">Duration</th>
                    <th className="pb-3 font-medium">Date</th>
                    <th className="pb-3 font-medium">Type</th>
                    <th className="pb-3 font-medium"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {backups.map(backup => {
                    const parsedError = parseBackupError(backup.error);
                    const isStructuredError = parsedError && typeof parsedError === 'object';
                    const isInProgress = backup.status === 'in_progress' || backup.status === 'pending';

                    return (
                      <tr key={backup.id} className="text-white">
                        <td className="py-3 font-mono text-xs">{backup.filename}</td>
                        <td className="py-3">
                          {backup.status === 'completed' ? formatBytes(backup.size) : '--'}
                        </td>
                        <td className="py-3">
                          {isInProgress ? (
                            <div className="flex items-center gap-2">
                              <div className="w-24 h-2 bg-slate-700 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-primary-500 transition-all duration-300"
                                  style={{ width: `${backup.progress}%` }}
                                />
                              </div>
                              <span className="text-xs text-slate-400">{backup.progress}%</span>
                            </div>
                          ) : (
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                              backup.status === 'completed'
                                ? 'bg-green-500/20 text-green-400'
                                : backup.status === 'failed'
                                ? 'bg-red-500/20 text-red-400'
                                : 'bg-slate-500/20 text-slate-400'
                            }`}>
                              {backup.status === 'completed' && (
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                              {backup.status === 'failed' && (
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              )}
                              {backup.status}
                            </span>
                          )}
                          {parsedError && (
                            <div className="mt-1">
                              {isStructuredError ? (
                                <details className="text-xs">
                                  <summary className="text-red-400 cursor-pointer hover:text-red-300">
                                    {parsedError.step}: {parsedError.message.substring(0, 50)}...
                                  </summary>
                                  <pre className="mt-1 p-2 bg-slate-900 rounded text-red-300 overflow-x-auto max-h-32">
                                    {parsedError.stderr || parsedError.message}
                                  </pre>
                                </details>
                              ) : (
                                <span className="text-xs text-red-400">{parsedError}</span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-3 text-slate-400">{formatDuration(backup.duration)}</td>
                        <td className="py-3 text-slate-400">
                          {format(new Date(backup.createdAt), 'MMM d, yyyy h:mm a')}
                        </td>
                        <td className="py-3">
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            backup.type === 'manual' ? 'bg-slate-700 text-slate-300' : 'bg-primary-500/20 text-primary-400'
                          }`}>
                            {backup.type}
                          </span>
                        </td>
                        <td className="py-3">
                          <div className="flex items-center gap-2 justify-end">
                            {allowDownload && backup.status === 'completed' && (
                              <button
                                onClick={() => handleDownload(backup)}
                                className="btn btn-ghost text-xs text-primary-400 hover:text-primary-300"
                                title="Download"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                              </button>
                            )}
                            <button
                              onClick={() => handleDeleteBackup(backup)}
                              className="btn btn-ghost text-xs text-red-400 hover:text-red-300"
                              title="Delete"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="mt-4">
                <Pagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  totalItems={totalBackups}
                  pageSize={pageSize}
                  onPageChange={(page) => {
                    setCurrentPage(page);
                    loadBackups(page);
                  }}
                  onPageSizeChange={() => {}}
                />
              </div>
            )}
          </>
        )}
      </div>
      )}
    </div>
  );
}

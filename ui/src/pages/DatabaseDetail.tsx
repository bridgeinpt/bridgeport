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
  setBackupPinned,
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
import { ArrowLeft, Check, X, Download, Trash2, Pin, PinOff } from 'lucide-react';
import { BackupRetentionCard } from '@/components/BackupRetentionCard';
import { safeJsonParse } from '../lib/helpers';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataPagination } from '@/components/ui/data-pagination';


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

const COLLECTION_INTERVALS = [
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
] as const;

interface BackupError {
  message: string;
  step: 'connect' | 'dump' | 'upload';
  stderr?: string;
  exitCode?: number;
}

function parseBackupError(error: string | null): BackupError | string | null {
  if (!error) return null;
  const parsed = safeJsonParse(error, null);
  return parsed !== null ? (parsed as BackupError) : error;
}

export default function DatabaseDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { selectedEnvironment, setBreadcrumbName } = useAppStore();
  const toast = useToast();
  const confirm = useConfirm();

  const [database, setDatabase] = useState<Database | null>(null);
  const [backups, setBackups] = useState<DatabaseBackup[]>([]);
  const [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [allowDownload, setAllowDownload] = useState(false);

  // Pagination (0-based, matching the rest of the app)
  const [currentPage, setCurrentPage] = useState(0);
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
    useSsl: false,
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
        useSsl: db.useSsl,
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

  const loadBackups = useCallback(async (page = 0) => {
    if (!id) return;
    setLoadingBackups(true);
    try {
      const offset = page * pageSize;
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
      await Promise.all([loadDatabase(), loadBackups(0), loadSchedule(), loadServers()]);
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
      await loadBackups(0);
      setCurrentPage(0);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Backup failed');
    } finally {
      setBackingUp(false);
    }
  };

  const handleDeleteBackup = async (backup: DatabaseBackup) => {
    const ok = await confirm({
      title: `Delete backup "${backup.filename}"?`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
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

  const handleTogglePin = async (backup: DatabaseBackup) => {
    if (!id) return;
    const willPin = !backup.isPinned;
    try {
      const { backup: updated } = await setBackupPinned(id, backup.id, willPin);
      setBackups(prev =>
        prev.map(b =>
          b.id === backup.id ? { ...b, isPinned: updated.isPinned, pinnedAt: updated.pinnedAt } : b
        )
      );
      toast.success(willPin ? 'Backup pinned (protected from rotation)' : 'Backup unpinned');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update pin');
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
        data.useSsl = connectionForm.useSsl;
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
    if (!id) return;
    const ok = await confirm({
      title: 'Delete backup schedule?',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
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
        <Skeleton className="h-8 w-64 mb-4" />
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-32 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (!database) {
    return (
      <div className="p-6">
        <div className="rounded-lg border bg-card p-4 text-center py-12">
          <p className="text-muted-foreground">Database not found</p>
          <Button asChild className="mt-4">
            <Link to="/databases">Back to Databases</Link>
          </Button>
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
          <Link to="/databases" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-5" />
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-foreground">{database.name}</span>
              <Badge variant="secondary">
                {database.databaseType?.displayName || database.type}
              </Badge>
            </div>
            <p className="text-muted-foreground font-mono text-sm mt-1">
              {database.host ? `${database.host}:${database.port}/${database.databaseName}` : database.filePath}
            </p>
          </div>
        </div>
        {database.databaseType?.hasBackupCommand !== false && (
        <div className="flex gap-2">
          <Button onClick={handleBackup} disabled={backingUp}>
            {backingUp ? 'Starting...' : 'Backup Now'}
          </Button>
        </div>
        )}
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Connection Info */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Connection Info</CardTitle>
            {!editingConnection && (
              <Button variant="ghost" size="sm" onClick={() => setEditingConnection(true)}>
                Edit
              </Button>
            )}
          </CardHeader>
          <CardContent>

          {editingConnection ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="conn-name">Name</Label>
                <Input
                  id="conn-name"
                  type="text"
                  value={connectionForm.name}
                  onChange={e => setConnectionForm({ ...connectionForm, name: e.target.value })}
                  placeholder="my-database"
                />
              </div>
              {database.type === 'sqlite' ? (
                <>
                  <div className="space-y-1.5">
                    <Label>Server</Label>
                    <Select
                      value={connectionForm.serverId || ''}
                      onValueChange={value => setConnectionForm({ ...connectionForm, serverId: value || null })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select server..." />
                      </SelectTrigger>
                      <SelectContent>
                        {servers.map(server => (
                          <SelectItem key={server.id} value={server.id}>{server.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Server to SSH into for SQLite backups</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="conn-filepath">File Path</Label>
                    <Input
                      id="conn-filepath"
                      type="text"
                      value={connectionForm.filePath}
                      onChange={e => setConnectionForm({ ...connectionForm, filePath: e.target.value })}
                      placeholder="/path/to/database.db"
                      className="font-mono text-sm"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="col-span-2 space-y-1.5">
                      <Label htmlFor="conn-host">Host</Label>
                      <Input
                        id="conn-host"
                        type="text"
                        value={connectionForm.host}
                        onChange={e => setConnectionForm({ ...connectionForm, host: e.target.value })}
                        placeholder="localhost"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="conn-port">Port</Label>
                      <Input
                        id="conn-port"
                        type="number"
                        value={connectionForm.port}
                        onChange={e => setConnectionForm({ ...connectionForm, port: parseInt(e.target.value) })}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="conn-dbname">Database Name</Label>
                    <Input
                      id="conn-dbname"
                      type="text"
                      value={connectionForm.databaseName}
                      onChange={e => setConnectionForm({ ...connectionForm, databaseName: e.target.value })}
                      placeholder="mydb"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="conn-username">Username</Label>
                      <Input
                        id="conn-username"
                        type="text"
                        value={connectionForm.username}
                        onChange={e => setConnectionForm({ ...connectionForm, username: e.target.value })}
                        placeholder={database.hasCredentials ? '(unchanged)' : ''}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="conn-password">Password</Label>
                      <Input
                        id="conn-password"
                        type="password"
                        value={connectionForm.password}
                        onChange={e => setConnectionForm({ ...connectionForm, password: e.target.value })}
                        placeholder={database.hasCredentials ? '(unchanged)' : ''}
                      />
                    </div>
                  </div>
                  <Label className="text-sm font-normal">
                    <Checkbox
                      checked={connectionForm.useSsl}
                      onCheckedChange={checked => setConnectionForm({ ...connectionForm, useSsl: checked === true })}
                    />
                    <span className="text-foreground">Use SSL/TLS</span>
                    <span className="text-muted-foreground">- Required for managed database services</span>
                  </Label>
                </>
              )}
              <div className="flex gap-2 pt-2">
                <Button onClick={handleSaveConnection} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditingConnection(false);
                    setConnectionForm({
                      name: database.name,
                      host: database.host || '',
                      port: database.port || 5432,
                      databaseName: database.databaseName || '',
                      username: '',
                      password: '',
                      useSsl: database.useSsl,
                      serverId: database.serverId,
                      filePath: database.filePath || '',
                    });
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <dl className="space-y-3 text-sm">
                {database.type !== 'sqlite' ? (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Host</dt>
                      <dd className="text-foreground font-mono">{database.host || '--'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Port</dt>
                      <dd className="text-foreground">{database.port || '--'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Database</dt>
                      <dd className="text-foreground font-mono">{database.databaseName || '--'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Credentials</dt>
                      <dd className="text-foreground">{database.hasCredentials ? 'Configured' : 'Not set'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">SSL/TLS</dt>
                      <dd className={database.useSsl ? 'text-success' : 'text-muted-foreground'}>{database.useSsl ? 'Enabled' : 'Disabled'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Server</dt>
                      <dd className="text-muted-foreground">None (direct connection)</dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">File Path</dt>
                      <dd className="text-foreground font-mono text-xs">{database.filePath || '--'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Server</dt>
                      <dd className="text-foreground">
                        {database.serverId
                          ? servers.find(s => s.id === database.serverId)?.name || 'Unknown'
                          : <span className="text-warning">Not configured</span>}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
              <Separator />
              <div className="flex items-center justify-between">
                <Button
                  variant="secondary"
                  size="sm"
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
                >
                  {testingConnection ? 'Testing...' : 'Test Connection'}
                </Button>
                {testResult && (
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${testResult.success ? 'bg-success' : 'bg-destructive'}`} />
                    {testResult.success ? (
                      <span className="text-xs text-muted-foreground">
                        {testResult.latencyMs}ms
                        {testResult.serverVersion && (
                          <span className="ml-1 text-muted-foreground">({testResult.serverVersion.split(' ').slice(0, 2).join(' ')})</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-xs text-destructive">{testResult.error}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          </CardContent>
        </Card>

        {/* Monitoring Card */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Monitoring</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/monitoring/databases">View Metrics</Link>
            </Button>
          </CardHeader>
          <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-foreground">Enable Monitoring</p>
                <p className="text-xs text-muted-foreground">Collect database metrics on a schedule</p>
              </div>
              <Button
                variant={monitoringEnabled ? 'default' : 'secondary'}
                size="sm"
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
              >
                {monitoringEnabled ? 'Enabled' : 'Disabled'}
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label>Collection Interval</Label>
              <Select
                value={String(collectionInterval)}
                onValueChange={async (value) => {
                  if (!selectedEnvironment?.id || !id) return;
                  const newInterval = parseInt(value);
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
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COLLECTION_INTERVALS.map(opt => (
                    <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          </CardContent>
        </Card>
      </div>

      {/* Backup Configuration + Schedule Row */}
      {database.databaseType?.hasBackupCommand !== false && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Backup Configuration */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Backup Configuration</CardTitle>
            {!editingConfig && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingConfig(true);
                  if (configForm.backupStorageType === 'spaces') loadBuckets();
                }}
              >
                Edit
              </Button>
            )}
          </CardHeader>
          <CardContent>

          {editingConfig ? (
            <div className="space-y-4">
              {/* Storage */}
              <div className="space-y-1.5">
                <Label>Storage</Label>
                <Select
                  value={configForm.backupStorageType}
                  onValueChange={value => {
                    const newType = value as 'local' | 'spaces';
                    setConfigForm({ ...configForm, backupStorageType: newType });
                    if (newType === 'spaces') loadBuckets();
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">Local Storage</SelectItem>
                    <SelectItem value="spaces">DO Spaces</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {configForm.backupStorageType === 'local' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="config-localpath">Local Path</Label>
                  <Input
                    id="config-localpath"
                    type="text"
                    value={configForm.backupLocalPath}
                    onChange={e => setConfigForm({ ...configForm, backupLocalPath: e.target.value })}
                    className="font-mono text-sm"
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label>Bucket</Label>
                    <Select
                      value={configForm.backupSpacesBucket}
                      onValueChange={value => setConfigForm({ ...configForm, backupSpacesBucket: value })}
                      disabled={loadingBuckets}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select bucket..." />
                      </SelectTrigger>
                      <SelectContent>
                        {spacesBuckets.map(bucket => (
                          <SelectItem key={bucket} value={bucket}>{bucket}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="config-prefix">Prefix</Label>
                    <Input
                      id="config-prefix"
                      type="text"
                      value={configForm.backupSpacesPrefix}
                      onChange={e => setConfigForm({ ...configForm, backupSpacesPrefix: e.target.value })}
                      placeholder="{environment}/{name}/"
                      className="font-mono text-sm"
                    />
                  </div>
                </>
              )}

              {/* Format (Postgres only) */}
              {database.type === 'postgres' && (
                <div className="space-y-1.5">
                  <Label>Format</Label>
                  <Select
                    value={configForm.backupFormat}
                    onValueChange={value => setConfigForm({ ...configForm, backupFormat: value as 'plain' | 'custom' | 'tar' })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BACKUP_FORMATS.map(f => (
                        <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Compression (for plain format) */}
              {(database.type !== 'postgres' || configForm.backupFormat === 'plain') && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Compression</Label>
                    <Select
                      value={configForm.backupCompression}
                      onValueChange={value => setConfigForm({ ...configForm, backupCompression: value as 'none' | 'gzip' })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {COMPRESSION_OPTIONS.map(c => (
                          <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {configForm.backupCompression === 'gzip' && (
                    <div className="space-y-1.5">
                      <Label htmlFor="config-complevel">Level (1-9)</Label>
                      <Input
                        id="config-complevel"
                        type="number"
                        min={1}
                        max={9}
                        value={configForm.backupCompressionLevel}
                        onChange={e => setConfigForm({ ...configForm, backupCompressionLevel: parseInt(e.target.value) || 6 })}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* pg_dump options (Postgres only) */}
              {database.type === 'postgres' && (
                <div>
                  <Label className="mb-2">pg_dump Options</Label>
                  <div className="space-y-2">
                    {PG_DUMP_OPTIONS.map(opt => (
                      <Label key={opt.key} className="text-sm font-normal">
                        <Checkbox
                          checked={!!configForm.pgDumpOptions[opt.key as keyof PgDumpOptions]}
                          onCheckedChange={checked => setConfigForm({
                            ...configForm,
                            pgDumpOptions: {
                              ...configForm.pgDumpOptions,
                              [opt.key]: checked === true,
                            },
                          })}
                        />
                        <span className="text-foreground">{opt.label}</span>
                        <span className="text-muted-foreground">- {opt.description}</span>
                      </Label>
                    ))}
                  </div>
                </div>
              )}

              {/* Backup Timeout (Postgres only) */}
              {database.type === 'postgres' && (
                <div className="space-y-1.5">
                  <Label htmlFor="config-timeout">
                    Backup Timeout <span className="text-muted-foreground">(seconds)</span>
                  </Label>
                  <Input
                    id="config-timeout"
                    type="number"
                    min={30}
                    max={3600}
                    value={configForm.pgDumpTimeoutSec}
                    onChange={e => setConfigForm({ ...configForm, pgDumpTimeoutSec: parseInt(e.target.value) || 300 })}
                    className="w-32"
                  />
                  <p className="text-xs text-muted-foreground">
                    Max time for pg_dump execution (default: 300s / 5 min)
                  </p>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button onClick={handleSaveConfig} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                <Button variant="ghost" onClick={() => setEditingConfig(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Storage</dt>
                <dd className="text-foreground">
                  {database.backupStorageType === 'local' ? 'Local' : 'DO Spaces'}
                </dd>
              </div>
              {database.backupStorageType === 'local' ? (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Path</dt>
                  <dd className="text-foreground font-mono text-xs">{database.backupLocalPath || '/var/backups'}</dd>
                </div>
              ) : (
                <>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Bucket</dt>
                    <dd className="text-foreground font-mono">{database.backupSpacesBucket || '--'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Prefix</dt>
                    <dd className="text-foreground font-mono text-xs">{database.backupSpacesPrefix || '(root)'}</dd>
                  </div>
                </>
              )}
              {database.type === 'postgres' && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Format</dt>
                  <dd className="text-foreground">
                    {BACKUP_FORMATS.find(f => f.value === database.backupFormat)?.label || 'Plain SQL'}
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Compression</dt>
                <dd className="text-foreground">
                  {database.backupCompression === 'gzip' ? `Gzip (level ${database.backupCompressionLevel})` : 'None'}
                </dd>
              </div>
              {database.type === 'postgres' && database.pgDumpOptions && Object.keys(database.pgDumpOptions).some(k => database.pgDumpOptions![k as keyof PgDumpOptions]) && (
                <div>
                  <dt className="text-muted-foreground mb-1">pg_dump Options</dt>
                  <dd className="flex flex-wrap gap-1">
                    {PG_DUMP_OPTIONS.filter(opt => database.pgDumpOptions![opt.key as keyof PgDumpOptions]).map(opt => (
                      <Badge key={opt.key} variant="secondary" className="text-xs">
                        {opt.label}
                      </Badge>
                    ))}
                  </dd>
                </div>
              )}
              {database.type === 'postgres' && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Backup Timeout</dt>
                  <dd className="text-foreground">{Math.round(database.pgDumpTimeoutMs / 1000)}s</dd>
                </div>
              )}
            </dl>
          )}
          </CardContent>
        </Card>

        {/* Schedule Card */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Backup Schedule</CardTitle>
            {!editingSchedule && (
              <Button variant="ghost" size="sm" onClick={() => setEditingSchedule(true)}>
                {schedule ? 'Edit' : 'Set Schedule'}
              </Button>
            )}
          </CardHeader>
          <CardContent>

          {editingSchedule ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="schedule-cron">Cron Expression</Label>
                <Input
                  id="schedule-cron"
                  type="text"
                  value={scheduleForm.cronExpression}
                  onChange={e => setScheduleForm({ ...scheduleForm, cronExpression: e.target.value })}
                  placeholder="0 2 * * *"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">e.g., "0 2 * * *" = daily at 2am</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-retention">Retention Days</Label>
                <Input
                  id="schedule-retention"
                  type="number"
                  min={1}
                  max={365}
                  value={scheduleForm.retentionDays}
                  onChange={e => setScheduleForm({ ...scheduleForm, retentionDays: parseInt(e.target.value) || 7 })}
                />
              </div>
              <Label htmlFor="scheduleEnabled" className="text-sm font-normal">
                <Checkbox
                  id="scheduleEnabled"
                  checked={scheduleForm.enabled}
                  onCheckedChange={checked => setScheduleForm({ ...scheduleForm, enabled: checked === true })}
                />
                <span className="text-foreground">Enabled</span>
              </Label>
              <div className="flex gap-2">
                <Button onClick={handleSaveSchedule} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                <Button variant="ghost" onClick={() => setEditingSchedule(false)}>Cancel</Button>
                {schedule && (
                  <Button variant="ghost" onClick={handleDeleteSchedule} className="text-destructive hover:text-destructive">
                    Delete Schedule
                  </Button>
                )}
              </div>
            </div>
          ) : schedule ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm">Status</span>
                <Button
                  variant={schedule.enabled ? 'default' : 'secondary'}
                  size="sm"
                  onClick={handleToggleSchedule}
                >
                  {schedule.enabled ? 'Enabled' : 'Disabled'}
                </Button>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Cron</span>
                <code className="font-mono text-foreground bg-muted px-2 py-0.5 rounded text-xs">
                  {schedule.cronExpression}
                </code>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Retention</span>
                <span className="text-foreground">{schedule.retentionDays} days</span>
              </div>
              {schedule.lastRunAt && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Last run</span>
                  <span className="text-foreground">{formatDistanceToNow(new Date(schedule.lastRunAt), { addSuffix: true })}</span>
                </div>
              )}
              {schedule.nextRunAt && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Next run</span>
                  <span className="text-foreground">{formatDistanceToNow(new Date(schedule.nextRunAt), { addSuffix: true })}</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No schedule configured</p>
          )}
          </CardContent>
        </Card>
      </div>
      )}

      {/* Backup Retention Policy (GFS rotation — issue #291) */}
      {database.databaseType?.hasBackupCommand !== false && (
        <div className="mb-6">
          <BackupRetentionCard databaseId={id!} onRotated={() => loadBackups(currentPage)} />
        </div>
      )}

      {/* Backups Table */}
      {database.databaseType?.hasBackupCommand !== false && (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>
            Backups
            {totalBackups > 0 && <span className="text-muted-foreground font-normal ml-2">({totalBackups})</span>}
          </CardTitle>
          {loadingBackups && <span className="text-muted-foreground text-sm">Refreshing...</span>}
        </CardHeader>
        <CardContent>

        {backups.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground">No backups yet</p>
            <Button onClick={handleBackup} disabled={backingUp} className="mt-4">
              Create First Backup
            </Button>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Filename</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backups.map(backup => {
                  const parsedError = parseBackupError(backup.error);
                  const isStructuredError = parsedError && typeof parsedError === 'object';
                  const isInProgress = backup.status === 'in_progress' || backup.status === 'pending';

                  return (
                    <TableRow key={backup.id}>
                      <TableCell className="font-mono text-xs">
                        <span className="inline-flex items-center gap-2">
                          {backup.filename}
                          {backup.isPinned && (
                            <Badge variant="info" className="gap-1 text-xs">
                              <Pin className="size-3" />
                              Protected
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        {backup.status === 'completed' ? formatBytes(backup.size) : '--'}
                      </TableCell>
                      <TableCell>
                        {isInProgress ? (
                          <div className="flex items-center gap-2">
                            <Progress value={backup.progress} className="w-24" />
                            <span className="text-xs text-muted-foreground">{backup.progress}%</span>
                          </div>
                        ) : (
                          <StatusBadge
                            kind="backup"
                            value={backup.status}
                            label={
                              <span className="inline-flex items-center gap-1">
                                {backup.status === 'completed' && <Check className="size-3" />}
                                {backup.status === 'failed' && <X className="size-3" />}
                                {backup.status}
                              </span>
                            }
                          />
                        )}
                        {parsedError && (
                          <div className="mt-1">
                            {isStructuredError ? (
                              <details className="text-xs">
                                <summary className="text-destructive cursor-pointer hover:text-destructive/80">
                                  {parsedError.step}: {parsedError.message.substring(0, 50)}...
                                </summary>
                                <pre className="mt-1 p-2 bg-muted rounded text-destructive overflow-x-auto max-h-32">
                                  {parsedError.stderr || parsedError.message}
                                </pre>
                              </details>
                            ) : (
                              <span className="text-xs text-destructive">{parsedError}</span>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDuration(backup.duration)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(backup.createdAt), 'MMM d, yyyy h:mm a')}
                      </TableCell>
                      <TableCell>
                        <Badge variant={backup.type === 'manual' ? 'secondary' : 'info'} className="text-xs">
                          {backup.type}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 justify-end">
                          {allowDownload && backup.status === 'completed' && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleDownload(backup)}
                              className="text-primary hover:text-primary/80"
                              title="Download"
                            >
                              <Download className="size-4" />
                            </Button>
                          )}
                          {backup.status === 'completed' && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleTogglePin(backup)}
                              className={backup.isPinned ? 'text-info hover:text-info/80' : 'text-muted-foreground hover:text-foreground'}
                              title={backup.isPinned ? 'Unpin (allow rotation to prune)' : 'Pin (protect from rotation)'}
                              aria-label={backup.isPinned ? 'Unpin backup' : 'Pin backup'}
                            >
                              {backup.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleDeleteBackup(backup)}
                            className="text-destructive hover:text-destructive/80"
                            title="Delete"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="mt-4">
                <DataPagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  totalItems={totalBackups}
                  pageSize={pageSize}
                  onPageChange={(page) => {
                    setCurrentPage(page);
                    loadBackups(page);
                  }}
                />
              </div>
            )}
          </>
        )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}

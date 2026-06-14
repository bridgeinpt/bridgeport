import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store.js';
import { useToast } from '../components/Toast.js';
import { usePaginatedFetch } from '../hooks/usePaginatedFetch.js';
import {
  listDatabases,
  createDatabase,
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
import { Database as DatabaseIcon, Trash2, RefreshCw, Check, X, Loader2 } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { DataPagination } from '@/components/ui/data-pagination';
import { Skeleton } from '@/components/ui/skeleton';

const STORAGE_TYPES = [
  { value: 'local', label: 'Local Storage' },
  { value: 'spaces', label: 'DO Spaces' },
] as const;

export default function Databases() {
  const { selectedEnvironment } = useAppStore();
  const toast = useToast();
  const confirm = useConfirm();
  const { items: databases, total, loading, currentPage, pageSize, totalPages, setCurrentPage, setPageSize, reload } =
    usePaginatedFetch<Database>({
      fetcher: ({ limit, offset }) =>
        listDatabases(selectedEnvironment!.id, { limit, offset }).then(r => ({
          items: r.databases,
          total: r.total,
        })),
      deps: [selectedEnvironment?.id],
      enabled: !!selectedEnvironment?.id,
    });
  const [servers, setServers] = useState<Server[]>([]);
  const [databaseTypes, setDatabaseTypes] = useState<DatabaseTypeRecord[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
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
    useSsl: true,
    serverId: '',
    backupStorageType: 'local',
    backupLocalPath: '/var/backups',
  });

  useEffect(() => {
    if (selectedEnvironment?.id) {
      Promise.all([
        listServers(selectedEnvironment.id),
        listDatabaseTypes(),
      ]).then(([serverRes, dbTypeRes]) => {
        setServers(serverRes.servers);
        setDatabaseTypes(dbTypeRes.databaseTypes);
      });
    }
  }, [selectedEnvironment?.id]);

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
      useSsl: true,
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
      if (formData.useSsl) data.useSsl = formData.useSsl;
      if (formData.serverId) data.serverId = formData.serverId;
      if (formData.filePath) data.filePath = formData.filePath;
      if (formData.backupLocalPath) data.backupLocalPath = formData.backupLocalPath;
      if (formData.backupSpacesBucket) data.backupSpacesBucket = formData.backupSpacesBucket;
      if (formData.backupSpacesPrefix) data.backupSpacesPrefix = formData.backupSpacesPrefix;

      await createDatabase(selectedEnvironment.id, data);
      reload();
      setShowCreate(false);
      resetForm();
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (db: Database) => {
    const ok = await confirm({
      title: `Delete database "${db.name}"?`,
      description: 'This will not delete actual data.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteDatabase(db.id);
      reload();
      toast.success('Database deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    }
  };

  const handleQuickBackup = async (db: Database) => {
    setBackingUpId(db.id);
    try {
      await createDatabaseBackup(db.id);
      toast.success('Backup started');
      // Refresh to show updated lastBackup
      reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Backup failed');
    } finally {
      setBackingUpId(null);
    }
  };

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <div className="rounded-lg border bg-card p-4 text-center py-12">
          <p className="text-muted-foreground">Select an environment</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-9 w-48" />
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-5">
        <Button onClick={() => setShowCreate(true)}>Add Database</Button>
      </div>

      {/* Create Modal */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreate(false);
            resetForm();
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Database</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="db-name">Name</Label>
              <Input
                id="db-name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="my-database"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={formData.type}
                onValueChange={(value) => {
                  const dbType = databaseTypes.find((t) => t.name === value);
                  setFormData({
                    ...formData,
                    type: value,
                    databaseTypeId: dbType?.id,
                    port: dbType?.defaultPort || undefined,
                    useSsl: value !== 'sqlite',
                    serverId: '',
                  });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {databaseTypes.length > 0 ? (
                    databaseTypes.map((t) => (
                      <SelectItem key={t.name} value={t.name}>
                        {t.displayName}
                      </SelectItem>
                    ))
                  ) : (
                    <>
                      <SelectItem value="postgres">PostgreSQL</SelectItem>
                      <SelectItem value="mysql">MySQL</SelectItem>
                      <SelectItem value="sqlite">SQLite</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>

            {formData.type !== 'sqlite' && (
              <>
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2 space-y-1.5">
                    <Label htmlFor="db-host">Host</Label>
                    <Input
                      id="db-host"
                      type="text"
                      value={formData.host}
                      onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                      placeholder="localhost"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="db-port">Port</Label>
                    <Input
                      id="db-port"
                      type="number"
                      value={formData.port}
                      onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="db-dbname">Database Name</Label>
                  <Input
                    id="db-dbname"
                    type="text"
                    value={formData.databaseName}
                    onChange={(e) => setFormData({ ...formData, databaseName: e.target.value })}
                    placeholder="mydb"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="db-username">Username</Label>
                    <Input
                      id="db-username"
                      type="text"
                      value={formData.username}
                      onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="db-password">Password</Label>
                    <Input
                      id="db-password"
                      type="password"
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    />
                  </div>
                </div>
                <Label className="text-sm font-normal">
                  <Checkbox
                    checked={formData.useSsl || false}
                    onCheckedChange={(checked) => setFormData({ ...formData, useSsl: checked === true })}
                  />
                  <span className="text-foreground">Use SSL/TLS</span>
                  <span className="text-muted-foreground">- Required for managed database services</span>
                </Label>
              </>
            )}

            {formData.type === 'sqlite' && (
              <>
                <div className="space-y-1.5">
                  <Label>Server</Label>
                  <Select
                    value={formData.serverId || ''}
                    onValueChange={(value) => setFormData({ ...formData, serverId: value })}
                    required
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select server..." />
                    </SelectTrigger>
                    <SelectContent>
                      {servers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Server where the SQLite file is located</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="db-filepath">File Path</Label>
                  <Input
                    id="db-filepath"
                    type="text"
                    value={formData.filePath}
                    onChange={(e) => setFormData({ ...formData, filePath: e.target.value })}
                    placeholder="/path/to/database.db"
                    className="font-mono text-sm"
                  />
                </div>
              </>
            )}

            <div className="space-y-1.5">
              <Label>Backup Storage</Label>
              <Select
                value={formData.backupStorageType}
                onValueChange={(value) => {
                  const newType = value as 'local' | 'spaces';
                  setFormData({ ...formData, backupStorageType: newType });
                  if (newType === 'spaces' && spacesBuckets.length === 0) {
                    loadBuckets();
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STORAGE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {formData.backupStorageType === 'local' && (
              <div className="space-y-1.5">
                <Label htmlFor="db-localpath">Local Path</Label>
                <Input
                  id="db-localpath"
                  type="text"
                  value={formData.backupLocalPath}
                  onChange={(e) => setFormData({ ...formData, backupLocalPath: e.target.value })}
                  placeholder="/var/backups"
                  className="font-mono text-sm"
                />
              </div>
            )}

            {formData.backupStorageType === 'spaces' && (
              <>
                <div className="space-y-1.5">
                  <Label>Spaces Bucket</Label>
                  <div className="flex gap-2">
                    <Select
                      value={formData.backupSpacesBucket || ''}
                      onValueChange={(value) => setFormData({ ...formData, backupSpacesBucket: value })}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select a bucket..." />
                      </SelectTrigger>
                      <SelectContent>
                        {spacesBuckets.map((bucket) => (
                          <SelectItem key={bucket} value={bucket}>
                            {bucket}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={loadBuckets}
                      disabled={loadingBuckets}
                      title="Refresh bucket list"
                    >
                      <RefreshCw className={loadingBuckets ? 'size-4 animate-spin' : 'size-4'} />
                    </Button>
                  </div>
                  {spacesBuckets.length === 0 && !loadingBuckets && (
                    <p className="text-xs text-muted-foreground">
                      No buckets found. Configure Spaces in Settings first.
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="db-prefix">Spaces Prefix</Label>
                  <Input
                    id="db-prefix"
                    type="text"
                    value={formData.backupSpacesPrefix || ''}
                    onChange={(e) => setFormData({ ...formData, backupSpacesPrefix: e.target.value })}
                    placeholder="{environment}/{name}/"
                    className="font-mono text-sm"
                  />
                </div>
              </>
            )}

            <DialogFooter className="pt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowCreate(false);
                  resetForm();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Databases List */}
      {total === 0 ? (
        <EmptyState
          icon={DatabaseIcon}
          message="No databases configured"
          description="Add a database to start managing backups"
          action={{ label: 'Add Your First Database', onClick: () => setShowCreate(true) }}
        />
      ) : (
        <div className="space-y-4">
          {databases.map((db) => {
            const supportsBackup = db.databaseType?.hasBackupCommand !== false;
            return (
            <Card key={db.id} className="gap-0 py-4">
              <div className="flex items-start justify-between px-4">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-purple-500/10 rounded-lg">
                    <DatabaseIcon className="size-6 text-purple-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/databases/${db.id}`}
                        className="text-lg font-semibold text-foreground hover:text-primary"
                      >
                        {db.name}
                      </Link>
                      <Badge variant="secondary" className="text-xs">
                        {db.databaseType?.displayName || databaseTypes.find((t) => t.name === db.type)?.displayName || db.type}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-sm mt-1 font-mono">
                      {db.host ? `${db.host}:${db.port}/${db.databaseName}` : db.filePath}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      {supportsBackup && (
                        <>
                          <span>{db._count?.backups || 0} backups</span>
                          <span>Storage: {STORAGE_TYPES.find((t) => t.value === db.backupStorageType)?.label}</span>
                          {db.schedule && (
                            <>
                              <span className={db.schedule.enabled ? 'text-success' : 'text-muted-foreground'}>
                                {db.schedule.enabled ? 'Scheduled' : 'Schedule disabled'}
                              </span>
                              {db.schedule.enabled && db.schedule.nextRunAt && (
                                <span className="text-muted-foreground">
                                  Next: {formatDistanceToNow(new Date(db.schedule.nextRunAt), { addSuffix: true })}
                                </span>
                              )}
                            </>
                          )}
                        </>
                      )}
                    </div>
                    {/* Backup Status Row */}
                    {supportsBackup && (
                    <div className="flex items-center gap-3 mt-2">
                      {db.lastBackup ? (
                        <>
                          <StatusBadge
                            kind="backup"
                            value={db.lastBackup.status}
                            label={
                              <span className="inline-flex items-center gap-1">
                                {db.lastBackup.status === 'completed' && <Check className="size-3" />}
                                {db.lastBackup.status === 'failed' && <X className="size-3" />}
                                {db.lastBackup.status === 'in_progress' && <Loader2 className="size-3 animate-spin" />}
                                Last backup: {db.lastBackup.status.replace('_', ' ')}
                              </span>
                            }
                          />
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(db.lastBackup.createdAt), { addSuffix: true })}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">No backups yet</span>
                      )}
                    </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {supportsBackup && (
                  <Button
                    onClick={() => handleQuickBackup(db)}
                    disabled={backingUpId === db.id}
                    size="sm"
                  >
                    {backingUpId === db.id ? 'Starting...' : 'Backup'}
                  </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(db)}
                    className="text-muted-foreground hover:text-destructive"
                    disabled={supportsBackup && (db._count?.backups || 0) > 0}
                    title={supportsBackup && (db._count?.backups || 0) > 0 ? 'Delete backups first' : 'Delete'}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </Card>
            );
          })}
          <DataPagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={total}
            pageSize={pageSize}
            onPageChange={setCurrentPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      )}
    </div>
  );
}

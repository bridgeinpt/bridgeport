import { useState, useMemo, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store.js';
import { usePaginatedFetch } from '../hooks/usePaginatedFetch.js';
import {
  listConfigFiles,
  getConfigFile,
  createConfigFile,
  updateConfigFile,
  deleteConfigFile,
  getConfigFileHistory,
  restoreConfigFile,
  uploadAssetFile,
  replaceAssetFile,
  syncConfigFileToAll,
  listConfigFragments,
  previewConfigFile,
  type ConfigFile,
  type ConfigFileServiceAttachment,
  type FileHistoryEntry,
  type ConfigFileSyncResult,
  type ConfigFragment,
} from '../lib/api.js';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Eye,
  History,
  RefreshCw,
  Trash2,
  FileText,
  ArrowUp,
  ArrowDown,
  X,
  Loader2,
} from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { OperationResultsModal, type OperationResult, type OperationStatus } from '../components/OperationResultsModal.js';
import { ConfigFileEditor, SUPPORTED_LANGUAGES } from '../components/ConfigFileEditor.js';
import { useToast } from '../components/Toast.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/ui/copy-button';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { DataPagination } from '@/components/ui/data-pagination';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface ServiceOption {
  id: string;
  name: string;
  serverName: string;
}

/**
 * Full sync-status union surfaced for both the per-file card badge and the
 * per-service attachment row (B8). The API types narrow these unions in places,
 * but the renderer must handle every value consistently — label + variant.
 */
type SyncStatusValue = 'synced' | 'pending' | 'outdated' | 'never' | 'not_attached';

/** Human label for a sync status, aligned with the StatusBadge variant. */
function syncStatusLabel(status: SyncStatusValue): string {
  switch (status) {
    case 'synced':
      return 'Synced';
    case 'pending':
      return 'Pending';
    case 'outdated':
      return 'Outdated';
    case 'not_attached':
      return 'Not attached';
    case 'never':
    default:
      return 'Never synced';
  }
}

export default function ConfigFiles() {
  const toast = useToast();
  const confirm = useConfirm();
  const {
    selectedEnvironment,
    configFilesAttachedFilter,
    setConfigFilesAttachedFilter,
    configFilesServiceFilter,
    setConfigFilesServiceFilter,
  } = useAppStore();
  const { items: configFiles, total, loading, currentPage, pageSize, totalPages, setCurrentPage, setPageSize, reload } =
    usePaginatedFetch<ConfigFile>({
      fetcher: ({ limit, offset }) =>
        listConfigFiles(selectedEnvironment!.id, { limit, offset }).then(r => ({
          items: r.configFiles,
          total: r.total,
        })),
      deps: [selectedEnvironment?.id],
      enabled: !!selectedEnvironment?.id,
    });

  const allServices = useMemo(() => {
    const serviceMap = new Map<string, ServiceOption>();
    for (const cf of configFiles) {
      for (const sf of cf.services || []) {
        if (!serviceMap.has(sf.service.id)) {
          const serverName =
            sf.serviceDeployment?.server.name ??
            sf.service.serviceDeployments?.[0]?.server.name ??
            '—';
          serviceMap.set(sf.service.id, {
            id: sf.service.id,
            name: sf.service.name,
            serverName,
          });
        }
      }
    }
    return Array.from(serviceMap.values()).sort((a, b) =>
      `${a.serverName}/${a.name}`.localeCompare(`${b.serverName}/${b.name}`)
    );
  }, [configFiles]);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFilename, setNewFilename] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newAutoResync, setNewAutoResync] = useState(true);
  const [newLanguage, setNewLanguage] = useState<string>('plaintext');
  const [newLanguageDirty, setNewLanguageDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingFile, setEditingFile] = useState<ConfigFile | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editAutoResync, setEditAutoResync] = useState(true);
  const [editLanguage, setEditLanguage] = useState<string>('plaintext');
  // Replacement file picked in the binary branch of the edit modal. Binary
  // content can't be edited inline, so "save" uploads this via the
  // replace-asset endpoint instead of PATCHing content.
  const [editReplaceFile, setEditReplaceFile] = useState<File | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [viewingFile, setViewingFile] = useState<(ConfigFile & { services: ConfigFileServiceAttachment[] }) | null>(null);
  const [historyFile, setHistoryFile] = useState<ConfigFile | null>(null);
  const [history, setHistory] = useState<FileHistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [selectedHistoryEntry, setSelectedHistoryEntry] = useState<FileHistoryEntry | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadFilename, setUploadFilename] = useState('');
  const [uploadDescription, setUploadDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [syncingFile, setSyncingFile] = useState<ConfigFile | null>(null);
  const [syncResults, setSyncResults] = useState<OperationResult[] | null>(null);
  // Tracks the terminal sync status returned by the backend (issue #127).
  // `no_targets` triggers a yellow "did nothing" banner in the modal.
  const [syncStatus, setSyncStatus] = useState<OperationStatus | undefined>(undefined);

  // Fragments: env-scoped list (loaded once per env). The create/edit modals
  // surface an ordered selector so users can include shared fragments before
  // their own content.
  const [availableFragments, setAvailableFragments] = useState<ConfigFragment[]>([]);
  // Ordered list of fragment ids selected for the create form.
  const [newFragmentIds, setNewFragmentIds] = useState<string[]>([]);
  // Same for the edit form. `null` ≠ `[]`: undefined → don't send fragmentIds on PATCH
  // (leave existing rows alone). The UI defaults to a real array when the editor
  // opens, so any state change replaces them server-side via PATCH.
  const [editFragmentIds, setEditFragmentIds] = useState<string[]>([]);

  // Preview pane (rendered/merged content) for the edit modal.
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedEnvironment?.id) return;
    listConfigFragments(selectedEnvironment.id)
      .then((res) => setAvailableFragments(res.fragments))
      .catch(() => setAvailableFragments([]));
  }, [selectedEnvironment?.id]);

  const resetCreateForm = () => {
    setNewName('');
    setNewFilename('');
    setNewContent('');
    setNewDescription('');
    setNewAutoResync(true);
    setNewLanguage('plaintext');
    setNewLanguageDirty(false);
    setNewFragmentIds([]);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;
    // The server's create schema requires non-empty content for text files;
    // catch it here so users get an inline message instead of a 400.
    if (!newContent.trim()) {
      toast.error('Content cannot be empty');
      return;
    }
    setCreating(true);
    try {
      await createConfigFile(selectedEnvironment.id, {
        name: newName,
        filename: newFilename,
        content: newContent,
        description: newDescription || undefined,
        autoResync: newAutoResync,
        // Only send `language` when the user explicitly chose one — otherwise
        // let the server auto-detect from `filename`.
        ...(newLanguageDirty ? { language: newLanguage } : {}),
        // Send fragmentIds when any are selected so the server creates the
        // ordered include rows. Omit when empty so we don't trip extra writes.
        ...(newFragmentIds.length > 0 ? { fragmentIds: newFragmentIds } : {}),
      });
      reload();
      setShowCreate(false);
      resetCreateForm();
    } catch (err) {
      // Surface API errors (e.g. 409 duplicate name) — previously swallowed,
      // leaving the modal open with no feedback.
      toast.error(err instanceof Error ? err.message : 'Failed to create config file');
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = async () => {
    if (!editingFile) return;
    setSavingEdit(true);
    try {
      // Replace the binary payload FIRST so a failed upload aborts the save
      // before any metadata is touched.
      if (editingFile.isBinary && editReplaceFile) {
        await replaceAssetFile(editingFile.id, editReplaceFile);
      }
      await updateConfigFile(editingFile.id, {
        // NEVER send content for binary files: the API strips binary content
        // to '' in responses, so editContent is always empty here — PATCHing
        // it back would wipe the stored payload. Replacement goes through
        // replaceAssetFile above instead.
        ...(editingFile.isBinary ? {} : { content: editContent }),
        description: editDescription || undefined,
        autoResync: editAutoResync,
        // Language is only meaningful for text files. For binary files the
        // language select is hidden, so don't re-assert a (possibly stale)
        // language on every unrelated edit — let the server keep what it has.
        ...(editingFile.isBinary ? {} : { language: editLanguage }),
        // Always send the fragmentIds list on edit (full-replace semantics).
        // Binary files skip the selector so we leave fragments alone.
        ...(editingFile.isBinary ? {} : { fragmentIds: editFragmentIds }),
      });
      setEditingFile(null);
      setEditContent('');
      setEditDescription('');
      setEditFragmentIds([]);
      setEditReplaceFile(null);
      setPreviewContent(null);
      setPreviewError(null);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save config file');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async (file: ConfigFile) => {
    const ok = await confirm({
      title: 'Delete Config File',
      description: `Are you sure you want to delete "${file.name}"? This action cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await deleteConfigFile(file.id);
    reload();
  };

  const handleSyncAll = async (file: ConfigFile) => {
    setSyncingFile(file);
    setSyncResults(null);
    setSyncStatus(undefined);
    try {
      const { results, status } = await syncConfigFileToAll(file.id);
      // Transform ConfigFileSyncResult to OperationResult
      const operationResults: OperationResult[] = results.map((r: ConfigFileSyncResult) => ({
        id: r.serviceId || r.serviceName,
        label: r.serverName,
        sublabel: r.serviceName,
        detail: r.targetPath,
        success: r.success,
        error: r.error,
      }));
      setSyncResults(operationResults);
      setSyncStatus(status);
      // Reload config files to update sync status
      reload();
    } catch (err) {
      setSyncResults([{
        id: 'error',
        label: 'Sync failed',
        success: false,
        error: err instanceof Error ? err.message : 'Sync failed',
      }]);
      setSyncStatus('failed');
    }
  };

  const handleView = async (file: ConfigFile) => {
    const { configFile } = await getConfigFile(file.id);
    setViewingFile(configFile);
  };

  const startEdit = async (file: ConfigFile) => {
    // Pull the full detail FIRST so we know which fragments are already
    // included (the list endpoint doesn't return includedFragments to keep
    // responses small). If this fails we MUST NOT enter edit mode with a
    // default-empty fragment list — a subsequent Save would full-replace the
    // existing rows with `[]`, silently wiping every fragment include on the
    // ConfigFile. Better to refuse to open the editor.
    let included: ConfigFile['includedFragments'];
    try {
      const { configFile } = await getConfigFile(file.id);
      included = configFile.includedFragments ?? [];
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Failed to load config file: ${err.message}`
          : 'Failed to load config file'
      );
      return;
    }

    setEditingFile(file);
    setEditContent(file.content || '');
    setEditDescription(file.description || '');
    setEditAutoResync(file.autoResync ?? true);
    setEditLanguage(file.language || 'plaintext');
    setEditReplaceFile(null);
    setPreviewContent(null);
    setPreviewError(null);
    const ids = (included ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((row) => row.fragment.id);
    setEditFragmentIds(ids);
  };

  const handlePreview = async () => {
    if (!editingFile) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      // Stateless preview: send the in-flight editor state in the body so
      // the server renders against it without persisting. Previously we
      // PATCH'd the row before previewing, which wrote a fileHistory entry
      // and bumped updatedAt — flipping ServiceFile sync status to "pending"
      // on every click.
      const result = await previewConfigFile(
        editingFile.id,
        editingFile.isBinary
          ? undefined
          : { content: editContent, fragmentIds: editFragmentIds },
      );
      setPreviewContent(result.content);
      if (result.missing.length > 0 || result.templateErrors.length > 0) {
        const parts = [];
        if (result.missing.length > 0) parts.push(`Missing: ${result.missing.join(', ')}`);
        if (result.templateErrors.length > 0) parts.push(`Errors: ${result.templateErrors.join('; ')}`);
        setPreviewError(parts.join(' — '));
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleViewHistory = async (file: ConfigFile) => {
    setHistoryFile(file);
    setLoadingHistory(true);
    try {
      const { history } = await getConfigFileHistory(file.id);
      setHistory(history);
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleRestore = async (entry: FileHistoryEntry) => {
    if (!historyFile) return;
    const ok = await confirm({
      title: 'Restore Version',
      description:
        'Are you sure you want to restore this version? The current content will be saved to history.',
      confirmText: 'Restore',
    });
    if (!ok) return;

    await restoreConfigFile(historyFile.id, entry.id);
    // Reload history to show the new entry
    const { history: updatedHistory } = await getConfigFileHistory(historyFile.id);
    setHistory(updatedHistory);
    setSelectedHistoryEntry(null);
    reload();
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id || !uploadFile) return;
    setUploading(true);
    try {
      await uploadAssetFile(
        selectedEnvironment.id,
        uploadFile,
        uploadName,
        uploadFilename || uploadFile.name,
        uploadDescription || undefined
      );
      reload();
      setShowUpload(false);
      setUploadFile(null);
      setUploadName('');
      setUploadFilename('');
      setUploadDescription('');
    } catch (err) {
      // Surface API errors (e.g. 409 duplicate name) — previously swallowed,
      // leaving the modal open with no feedback.
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const formatFileSize = (bytes: number | null): string => {
    if (bytes === null) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Filter config files based on filters
  const filteredConfigFiles = configFiles.filter((f) => {
    // "Only attached" filter
    if (configFilesAttachedFilter && (!f._count || f._count.services === 0)) {
      return false;
    }
    // Service filter - check if this config file is attached to the selected service
    if (configFilesServiceFilter) {
      const isAttached = f.services?.some((sf) => sf.service.id === configFilesServiceFilter);
      if (!isAttached) {
        return false;
      }
    }
    return true;
  });

  if (!selectedEnvironment) {
    return (
      <div className="p-6">
        <div className="rounded-lg border bg-card text-center py-12">
          <p className="text-muted-foreground">Please select an environment</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-5">
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowUpload(true)}>
            Upload Asset
          </Button>
          <Button onClick={() => setShowCreate(true)}>New Config File</Button>
        </div>
      </div>

      {/* Create Modal */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreate(false);
            resetCreateForm();
          }
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Config File</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="new-name">Display Name</Label>
                <Input
                  id="new-name"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="gateway-compose"
                  className="mt-1"
                  required
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Human-readable name (e.g., gateway-compose, cloudflare-cert)
                </p>
              </div>
              <div>
                <Label htmlFor="new-filename">Filename</Label>
                <Input
                  id="new-filename"
                  type="text"
                  value={newFilename}
                  onChange={(e) => setNewFilename(e.target.value)}
                  placeholder="docker-compose.yml"
                  className="mt-1"
                  required
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Target filename on server
                </p>
              </div>
            </div>
            <div>
              <Label htmlFor="new-description">Description (optional)</Label>
              <Input
                id="new-description"
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Docker Compose file for gateway service"
                className="mt-1"
              />
            </div>
            <div>
              <div className="flex items-end justify-between mb-1 gap-3">
                <Label>Content</Label>
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground" htmlFor="new-language">
                    Language
                  </Label>
                  <Select
                    value={newLanguage}
                    onValueChange={(value) => {
                      setNewLanguage(value);
                      setNewLanguageDirty(true);
                    }}
                  >
                    <SelectTrigger size="sm" id="new-language" className="w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_LANGUAGES.map((lang) => (
                        <SelectItem key={lang} value={lang}>
                          {lang}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <ConfigFileEditor
                value={newContent}
                onChange={setNewContent}
                language={newLanguage}
                height="22rem"
              />
              {!newLanguageDirty && (
                <p className="text-xs text-muted-foreground mt-1">
                  Language is auto-detected from the filename on save.
                </p>
              )}
            </div>
            <FragmentSelector
              label="Included Fragments"
              available={availableFragments}
              selectedIds={newFragmentIds}
              onChange={setNewFragmentIds}
            />
            <div>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox
                  checked={newAutoResync}
                  onCheckedChange={(checked) => setNewAutoResync(checked === true)}
                />
                <span>Auto re-sync when referenced values change</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                When a secret or variable referenced as <code>{'${KEY}'}</code> is updated, BRIDGEPORT will re-sync this file to all attached services.
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowCreate(false);
                  resetCreateForm();
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

      {/* Upload Asset Modal */}
      <Dialog
        open={showUpload}
        onOpenChange={(open) => {
          if (!open) {
            setShowUpload(false);
            setUploadFile(null);
            setUploadName('');
            setUploadFilename('');
            setUploadDescription('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upload Asset File</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleUpload} className="space-y-4">
            <div>
              <Label htmlFor="upload-file">File</Label>
              <Input
                id="upload-file"
                type="file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setUploadFile(file);
                    if (!uploadName) {
                      const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9-_]/g, '-');
                      setUploadName(nameWithoutExt);
                    }
                    if (!uploadFilename) {
                      setUploadFilename(file.name);
                    }
                  }
                }}
                className="mt-1"
                required
              />
              {uploadFile && (
                <p className="text-xs text-muted-foreground mt-1">
                  {formatFileSize(uploadFile.size)} • {uploadFile.type || 'unknown type'}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="upload-name">Display Name</Label>
                <Input
                  id="upload-name"
                  type="text"
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  placeholder="cloudflare-cert"
                  className="mt-1"
                  required
                />
              </div>
              <div>
                <Label htmlFor="upload-filename">Filename</Label>
                <Input
                  id="upload-filename"
                  type="text"
                  value={uploadFilename}
                  onChange={(e) => setUploadFilename(e.target.value)}
                  placeholder="cert.pem"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">Defaults to uploaded filename</p>
              </div>
            </div>
            <div>
              <Label htmlFor="upload-description">Description (optional)</Label>
              <Input
                id="upload-description"
                type="text"
                value={uploadDescription}
                onChange={(e) => setUploadDescription(e.target.value)}
                placeholder="Cloudflare origin certificate"
                className="mt-1"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowUpload(false);
                  setUploadFile(null);
                  setUploadName('');
                  setUploadFilename('');
                  setUploadDescription('');
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={uploading}>
                {uploading ? 'Uploading...' : 'Upload'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Modal */}
      <Dialog
        open={!!editingFile}
        onOpenChange={(open) => {
          if (!open) {
            setEditingFile(null);
            setEditContent('');
            setEditDescription('');
            setEditReplaceFile(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{`Edit: ${editingFile?.name || ''}`}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-description">Description</Label>
              <Input
                id="edit-description"
                type="text"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Description"
                className="mt-1"
              />
            </div>
            <div>
              <div className="flex items-end justify-between mb-1 gap-3">
                <Label>Content</Label>
                {!editingFile?.isBinary && (
                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground" htmlFor="edit-language">
                      Language
                    </Label>
                    <Select
                      value={editLanguage}
                      onValueChange={(value) => setEditLanguage(value)}
                    >
                      <SelectTrigger size="sm" id="edit-language" className="w-[140px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPORTED_LANGUAGES.map((lang) => (
                          <SelectItem key={lang} value={lang}>
                            {lang}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              {editingFile?.isBinary ? (
                <div className="p-4 bg-muted/50 rounded-lg border space-y-3">
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <FileText className="w-8 h-8" />
                    <div>
                      <p className="text-foreground font-medium">Binary File</p>
                      <p className="text-sm text-muted-foreground">
                        {formatFileSize(editingFile.fileSize)} • {editingFile.mimeType || 'Unknown type'}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Binary files cannot be edited inline. Choose a replacement file below — it
                        replaces the content on save (history is kept for rollback).
                      </p>
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="edit-replace-file">Replace file</Label>
                    <Input
                      id="edit-replace-file"
                      type="file"
                      onChange={(e) => setEditReplaceFile(e.target.files?.[0] || null)}
                      className="mt-1"
                    />
                    {editReplaceFile && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Will replace with: {editReplaceFile.name} (
                        {formatFileSize(editReplaceFile.size)})
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <ConfigFileEditor
                  value={editContent}
                  onChange={setEditContent}
                  language={editLanguage}
                  height="28rem"
                  autoFocus
                />
              )}
            </div>
            {!editingFile?.isBinary && (
              <FragmentSelector
                label="Included Fragments"
                available={availableFragments}
                selectedIds={editFragmentIds}
                onChange={setEditFragmentIds}
              />
            )}
            {!editingFile?.isBinary && (
              <div className="border rounded-lg p-3 bg-muted/30">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">
                    Rendered preview (fragments + content + placeholders)
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handlePreview}
                    disabled={previewLoading}
                  >
                    {previewLoading ? 'Rendering…' : 'Preview'}
                  </Button>
                </div>
                {previewError && (
                  <p className="text-xs text-warning mb-2">{previewError}</p>
                )}
                {previewContent !== null && (
                  <div className="relative">
                    <CopyButton value={previewContent} className="absolute top-1 right-1 z-10" />
                    <pre className="bg-muted rounded p-2 text-xs text-foreground font-mono whitespace-pre-wrap max-h-64 overflow-auto">
                      {previewContent}
                    </pre>
                  </div>
                )}
                {previewContent === null && !previewError && (
                  <p className="text-xs text-muted-foreground">
                    Click Preview to render this ConfigFile&apos;s fragments + content with
                    <code className="mx-1">{'${KEY}'}</code> placeholders resolved.
                  </p>
                )}
              </div>
            )}
            <div>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox
                  checked={editAutoResync}
                  onCheckedChange={(checked) => setEditAutoResync(checked === true)}
                />
                <span>Auto re-sync when referenced values change</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                When a secret or variable referenced as <code>{'${KEY}'}</code> is updated, BRIDGEPORT will re-sync this file to all attached services.
              </p>
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingFile(null);
                  setEditContent('');
                  setEditDescription('');
                  setEditReplaceFile(null);
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleEdit} disabled={savingEdit}>
                {savingEdit ? 'Saving...' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* View Modal */}
      <Dialog
        open={!!viewingFile}
        onOpenChange={(open) => {
          if (!open) setViewingFile(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{viewingFile?.name || ''}</DialogTitle>
          </DialogHeader>
          {viewingFile && (
            <div className="flex flex-col" style={{ maxHeight: 'calc(90vh - 120px)' }}>
              <p className="text-sm text-muted-foreground mb-4">
                {viewingFile.filename}
                {viewingFile.description && ` - ${viewingFile.description}`}
              </p>

              {/* Attached Services with Sync Status */}
              {viewingFile.services.length > 0 && (
                <div className="mb-4 p-3 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground mb-2">Attached to services:</p>
                  <div className="space-y-1">
                    {viewingFile.services.map((sf) => {
                      const serverName =
                        sf.serviceDeployment?.server.name ??
                        sf.service.serviceDeployments?.[0]?.server.name ??
                        '—';
                      const status = (sf.syncStatus ?? undefined) as SyncStatusValue | undefined;
                      return (
                      <div key={sf.id} className="flex items-center gap-2 text-sm">
                        <span className="text-foreground">{serverName}</span>
                        <span className="text-muted-foreground">/</span>
                        <Link
                          to={`/services/${sf.service.id}`}
                          className="text-primary hover:text-primary/80 hover:underline"
                        >
                          {sf.service.name}
                        </Link>
                        <span className="text-muted-foreground">→</span>
                        <code className="text-success text-xs">{sf.targetPath}</code>
                        {status && (
                          <StatusBadge
                            kind="sync"
                            value={status}
                            label={syncStatusLabel(status)}
                            className="ml-auto"
                          />
                        )}
                      </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Included Fragments (display-only, in position order) */}
              {viewingFile.includedFragments && viewingFile.includedFragments.length > 0 && (
                <div className="mb-4 p-3 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground mb-2">Included fragments:</p>
                  <ol className="space-y-1 list-decimal list-inside">
                    {[...viewingFile.includedFragments]
                      .sort((a, b) => a.position - b.position)
                      .map((inc) => (
                        <li key={inc.id} className="text-sm">
                          <span className="font-mono text-foreground">{inc.fragment.name}</span>
                          {inc.fragment.description && (
                            <span className="text-muted-foreground"> — {inc.fragment.description}</span>
                          )}
                        </li>
                      ))}
                  </ol>
                </div>
              )}

              {viewingFile.isBinary ? (
                <div className="flex-1 flex items-center justify-center p-8 bg-muted rounded-lg">
                  <div className="text-center">
                    <FileText className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
                    <p className="text-foreground font-medium mb-1">Binary File</p>
                    <p className="text-muted-foreground text-sm">
                      {formatFileSize(viewingFile.fileSize)} • {viewingFile.mimeType || 'Unknown type'}
                    </p>
                    <p className="text-muted-foreground text-xs mt-2">
                      Binary file content cannot be displayed
                    </p>
                  </div>
                </div>
              ) : (
                <ConfigFileEditor
                  value={viewingFile.content || ''}
                  language={viewingFile.language || 'plaintext'}
                  readOnly
                  height="60vh"
                  className="flex-1"
                />
              )}

              <DialogFooter className="mt-4">
                {!viewingFile.isBinary && viewingFile.content && (
                  <CopyButton value={viewingFile.content} label="Copy Content" variant="secondary" />
                )}
                <Button
                  variant="secondary"
                  onClick={() => {
                    startEdit(viewingFile);
                    setViewingFile(null);
                  }}
                >
                  Edit
                </Button>
                <Button variant="ghost" onClick={() => setViewingFile(null)}>
                  Close
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* History Modal */}
      <Dialog
        open={!!historyFile}
        onOpenChange={(open) => {
          if (!open) {
            setHistoryFile(null);
            setHistory([]);
            setSelectedHistoryEntry(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{`History: ${historyFile?.name || ''}`}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            {history.length} previous version{history.length !== 1 ? 's' : ''}
          </p>

          {loadingHistory ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : history.length === 0 ? (
            <div className="flex items-center justify-center text-muted-foreground py-12">
              No edit history available
            </div>
          ) : (
            <div className="flex gap-4" style={{ height: '60vh' }}>
              {/* History List */}
              <div className="w-64 flex-shrink-0 overflow-y-auto space-y-2">
                {history.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => setSelectedHistoryEntry(entry)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedHistoryEntry?.id === entry.id
                        ? 'bg-primary/10 border-primary'
                        : 'bg-muted/50 hover:border-ring'
                    }`}
                  >
                    <p className="text-sm text-foreground">
                      {format(new Date(entry.editedAt), 'MMM d, yyyy')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(entry.editedAt), 'h:mm a')}
                    </p>
                    {entry.editedBy && (
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        by {entry.editedBy.name || entry.editedBy.email}
                      </p>
                    )}
                  </button>
                ))}
              </div>

              {/* Content Preview */}
              <div className="flex-1 flex flex-col overflow-hidden">
                {selectedHistoryEntry ? (
                  <>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm text-muted-foreground">
                        Content at {format(new Date(selectedHistoryEntry.editedAt), 'MMM d, yyyy h:mm a')}
                      </p>
                      <Button
                        size="sm"
                        onClick={() => handleRestore(selectedHistoryEntry)}
                      >
                        Restore This Version
                      </Button>
                    </div>
                    {historyFile?.isBinary ? (
                      <div className="flex-1 flex items-center justify-center p-8 bg-muted rounded-lg text-muted-foreground">
                        Binary file — content not available
                      </div>
                    ) : (
                      <ConfigFileEditor
                        value={selectedHistoryEntry.content || ''}
                        language={historyFile?.language || 'plaintext'}
                        readOnly
                        height="100%"
                        className="flex-1"
                      />
                    )}
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    Select a version to preview
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Sync Results Modal */}
      <OperationResultsModal
        isOpen={!!syncingFile}
        onClose={() => {
          setSyncingFile(null);
          setSyncResults(null);
          setSyncStatus(undefined);
        }}
        title={`Sync: ${syncingFile?.name || ''}`}
        loadingMessage="Syncing to all attached services..."
        results={syncResults}
        status={syncStatus}
        noTargetsMessage="This config file is not attached to any service — sync did nothing."
      />

      {/* Filters */}
      <div className="mb-5 flex items-center gap-6 flex-wrap">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={configFilesAttachedFilter}
            onCheckedChange={(checked) => setConfigFilesAttachedFilter(checked === true)}
          />
          Only show files attached to services
        </label>
        {allServices.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Service:</span>
            <Select
              value={configFilesServiceFilter || 'all'}
              onValueChange={(value) => setConfigFilesServiceFilter(value === 'all' ? null : value)}
            >
              <SelectTrigger size="sm" aria-label="Service" className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Services</SelectItem>
                {allServices.map((service) => (
                  <SelectItem key={service.id} value={service.id}>
                    {service.serverName} / {service.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <span className="text-sm text-muted-foreground">
          ({filteredConfigFiles.length} of {configFiles.length} files)
        </span>
      </div>

      {/* Config Files Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredConfigFiles.map((file) => (
          <Card key={file.id} className="gap-0 py-4 transition-colors hover:border-ring">
            <div className="px-4">
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-foreground truncate">{file.name}</h3>
                    {file.isBinary && (
                      <Badge variant="secondary" title={file.mimeType || 'Binary file'}>
                        binary
                      </Badge>
                    )}
                    {!file.isBinary &&
                      file.language &&
                      file.language !== 'text' &&
                      file.language !== 'plaintext' && (
                        <Badge variant="info" title={`Language: ${file.language}`}>
                          {file.language}
                        </Badge>
                      )}
                  </div>
                  <p className="text-sm text-muted-foreground truncate font-mono">{file.filename}</p>
                  {file.isBinary && file.fileSize && (
                    <p className="text-xs text-muted-foreground">{formatFileSize(file.fileSize)}</p>
                  )}
                </div>
                <div className="flex gap-1 ml-2">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleView(file)}
                    title="View"
                  >
                    <Eye className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleViewHistory(file)}
                    title="History"
                  >
                    <History className="w-4 h-4" />
                  </Button>
                  {file._count && file._count.services > 0 && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleSyncAll(file)}
                      className="hover:text-primary"
                      title="Sync to all services"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleDelete(file)}
                    className="hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              {file.description && (
                <p className="text-xs text-muted-foreground mb-2">{file.description}</p>
              )}
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Updated {formatDistanceToNow(new Date(file.updatedAt), { addSuffix: true })}
                </span>
                <div className="flex items-center gap-2">
                  {/* Sync Status Badge */}
                  {file.syncStatus && file.syncStatus !== 'not_attached' && (
                    <StatusBadge
                      kind="sync"
                      value={file.syncStatus}
                      label={
                        file.syncStatus === 'pending'
                          ? `${file.syncCounts?.pending || 0} pending`
                          : syncStatusLabel(file.syncStatus as SyncStatusValue)
                      }
                    />
                  )}
                  {file._count && file._count.services > 0 && (
                    <Badge variant="info">
                      {file._count.services} service{file._count.services !== 1 ? 's' : ''}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </Card>
        ))}

        {filteredConfigFiles.length === 0 && configFiles.length > 0 && (
          <div className="col-span-full rounded-lg border bg-card text-center py-12">
            <p className="text-muted-foreground">No config files match the filter</p>
            <Button
              variant="ghost"
              className="mt-4"
              onClick={() => {
                setConfigFilesAttachedFilter(false);
                setConfigFilesServiceFilter(null);
              }}
            >
              Clear Filters
            </Button>
          </div>
        )}

        {total === 0 && (
          <div className="col-span-full">
            <EmptyState
              message="No config files yet"
              description="Store docker-compose files, Caddyfiles, certificates, and more"
              action={{ label: 'Create First Config File', onClick: () => setShowCreate(true) }}
            />
          </div>
        )}
      </div>
      {total > 0 && (
        <DataPagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={total}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={setPageSize}
        />
      )}
    </div>
  );
}

/**
 * Ordered fragment-include selector. Each row shows the fragment name with
 * up/down arrows for reorder and a remove button. The "Add fragment" select at
 * the bottom appends a new entry to the end of the list.
 *
 * Keeping this as up/down arrows (vs. native HTML5 DnD) is deliberate: the UI
 * doesn't already depend on a drag-and-drop library, the list is small in
 * practice (a few fragments per ConfigFile), and arrows are keyboard-friendly.
 */
interface FragmentSelectorProps {
  label: string;
  available: ConfigFragment[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

function FragmentSelector({ label, available, selectedIds, onChange }: FragmentSelectorProps) {
  const byId = useMemo(() => new Map(available.map((f) => [f.id, f])), [available]);
  const remaining = available.filter((f) => !selectedIds.includes(f.id));

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= selectedIds.length) return;
    const next = selectedIds.slice();
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const remove = (index: number) => {
    const next = selectedIds.slice();
    next.splice(index, 1);
    onChange(next);
  };

  const add = (id: string) => {
    if (!id) return;
    onChange([...selectedIds, id]);
  };

  return (
    <div>
      <Label className="mb-1 block">{label}</Label>
      {selectedIds.length === 0 ? (
        <p className="text-xs text-muted-foreground mb-2">
          No fragments included. Add one below to prepend its content before this
          ConfigFile&apos;s own content at render time.
        </p>
      ) : (
        <ul className="space-y-1 mb-2">
          {selectedIds.map((id, index) => {
            const fragment = byId.get(id);
            return (
              <li
                key={id}
                className="flex items-center gap-2 bg-muted/50 border rounded px-2 py-1.5"
              >
                <span className="text-xs text-muted-foreground font-mono w-6 text-right">
                  {index + 1}.
                </span>
                <span className="text-sm font-mono text-foreground flex-1">
                  {fragment?.name ?? `(missing fragment ${id})`}
                </span>
                {fragment?.description && (
                  <span className="text-xs text-muted-foreground truncate">
                    {fragment.description}
                  </span>
                )}
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    title="Move up"
                  >
                    <ArrowUp className="w-3 h-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => move(index, 1)}
                    disabled={index === selectedIds.length - 1}
                    title="Move down"
                  >
                    <ArrowDown className="w-3 h-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => remove(index)}
                    className="hover:text-destructive"
                    title="Remove"
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {remaining.length > 0 ? (
        <Select
          value=""
          onValueChange={(value) => add(value)}
        >
          <SelectTrigger size="sm" aria-label="Add fragment" className="w-full">
            <SelectValue placeholder="Add fragment…" />
          </SelectTrigger>
          <SelectContent>
            {remaining.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
                {f.description ? ` — ${f.description}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : available.length > 0 ? (
        <p className="text-xs text-muted-foreground">All fragments are already included.</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No fragments defined in this environment yet — create one from the Fragments page.
        </p>
      )}
    </div>
  );
}

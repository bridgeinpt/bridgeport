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
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { getSyncStatusColor } from '../lib/status.js';
import { RefreshIcon } from '../components/Icons.js';
import Pagination from '../components/Pagination.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { EmptyState } from '../components/EmptyState.js';
import { OperationResultsModal, type OperationResult, type OperationStatus } from '../components/OperationResultsModal.js';
import { ConfigFileEditor, SUPPORTED_LANGUAGES } from '../components/ConfigFileEditor.js';
import { useToast } from '../components/Toast.js';

interface ServiceOption {
  id: string;
  name: string;
  serverName: string;
}

export default function ConfigFiles() {
  const toast = useToast();
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
  const [deleteConfirm, setDeleteConfirm] = useState<ConfigFile | null>(null);

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

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await deleteConfigFile(deleteConfirm.id);
    setDeleteConfirm(null);
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

  const [restoreConfirm, setRestoreConfirm] = useState<FileHistoryEntry | null>(null);

  const handleRestore = async () => {
    if (!historyFile || !restoreConfirm) return;

    await restoreConfigFile(historyFile.id, restoreConfirm.id);
    // Reload history to show the new entry
    const { history: updatedHistory } = await getConfigFileHistory(historyFile.id);
    setHistory(updatedHistory);
    setSelectedHistoryEntry(null);
    setRestoreConfirm(null);
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
        <div className="panel text-center py-12">
          <p className="text-slate-400">Please select an environment</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <LoadingSkeleton rows={3} rowHeight="h-24" headerWidth="w-48" />;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-5">
        <div className="flex gap-2">
          <button onClick={() => setShowUpload(true)} className="btn btn-secondary">
            Upload Asset
          </button>
          <button onClick={() => setShowCreate(true)} className="btn btn-primary">
            New Config File
          </button>
        </div>
      </div>

      {/* Create Modal */}
      <Modal
        isOpen={showCreate}
        onClose={() => {
          setShowCreate(false);
          resetCreateForm();
        }}
        title="New Config File"
        size="lg"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Display Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="gateway-compose"
                className="input"
                required
              />
              <p className="text-xs text-slate-500 mt-1">
                Human-readable name (e.g., gateway-compose, cloudflare-cert)
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Filename</label>
              <input
                type="text"
                value={newFilename}
                onChange={(e) => setNewFilename(e.target.value)}
                placeholder="docker-compose.yml"
                className="input"
                required
              />
              <p className="text-xs text-slate-500 mt-1">
                Target filename on server
              </p>
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Description (optional)</label>
            <input
              type="text"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Docker Compose file for gateway service"
              className="input"
            />
          </div>
          <div>
            <div className="flex items-end justify-between mb-1 gap-3">
              <label className="block text-sm text-slate-400">Content</label>
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500" htmlFor="new-language">
                  Language
                </label>
                <select
                  id="new-language"
                  value={newLanguage}
                  onChange={(e) => {
                    setNewLanguage(e.target.value);
                    setNewLanguageDirty(true);
                  }}
                  className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white"
                >
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <ConfigFileEditor
              value={newContent}
              onChange={setNewContent}
              language={newLanguage}
              height="22rem"
            />
            {!newLanguageDirty && (
              <p className="text-xs text-slate-500 mt-1">
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
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={newAutoResync}
                onChange={(e) => setNewAutoResync(e.target.checked)}
              />
              <span>Auto re-sync when referenced values change</span>
            </label>
            <p className="text-xs text-slate-500 mt-1 ml-6">
              When a secret or variable referenced as <code>{'${KEY}'}</code> is updated, BRIDGEPORT will re-sync this file to all attached services.
            </p>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                resetCreateForm();
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
      </Modal>

      {/* Upload Asset Modal */}
      <Modal
        isOpen={showUpload}
        onClose={() => {
          setShowUpload(false);
          setUploadFile(null);
          setUploadName('');
          setUploadFilename('');
          setUploadDescription('');
        }}
        title="Upload Asset File"
        size="md"
      >
        <form onSubmit={handleUpload} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">File</label>
            <input
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
              className="block w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:bg-slate-700 file:text-white hover:file:bg-slate-600"
              required
            />
            {uploadFile && (
              <p className="text-xs text-slate-500 mt-1">
                {formatFileSize(uploadFile.size)} • {uploadFile.type || 'unknown type'}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Display Name</label>
              <input
                type="text"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                placeholder="cloudflare-cert"
                className="input"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Filename</label>
              <input
                type="text"
                value={uploadFilename}
                onChange={(e) => setUploadFilename(e.target.value)}
                placeholder="cert.pem"
                className="input"
              />
              <p className="text-xs text-slate-500 mt-1">Defaults to uploaded filename</p>
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Description (optional)</label>
            <input
              type="text"
              value={uploadDescription}
              onChange={(e) => setUploadDescription(e.target.value)}
              placeholder="Cloudflare origin certificate"
              className="input"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setShowUpload(false);
                setUploadFile(null);
                setUploadName('');
                setUploadFilename('');
                setUploadDescription('');
              }}
              className="btn btn-ghost"
            >
              Cancel
            </button>
            <button type="submit" disabled={uploading} className="btn btn-primary">
              {uploading ? 'Uploading...' : 'Upload'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Modal */}
      <Modal
        isOpen={!!editingFile}
        onClose={() => {
          setEditingFile(null);
          setEditContent('');
          setEditDescription('');
          setEditReplaceFile(null);
        }}
        title={`Edit: ${editingFile?.name || ''}`}
        size="3xl"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Description</label>
            <input
              type="text"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="Description"
              className="input"
            />
          </div>
          <div>
            <div className="flex items-end justify-between mb-1 gap-3">
              <label className="block text-sm text-slate-400">Content</label>
              {!editingFile?.isBinary && (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-500" htmlFor="edit-language">
                    Language
                  </label>
                  <select
                    id="edit-language"
                    value={editLanguage}
                    onChange={(e) => setEditLanguage(e.target.value)}
                    className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white"
                  >
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <option key={lang} value={lang}>
                        {lang}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {editingFile?.isBinary ? (
              <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-3">
                <div className="flex items-center gap-3 text-slate-400">
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <div>
                    <p className="text-white font-medium">Binary File</p>
                    <p className="text-sm text-slate-500">
                      {formatFileSize(editingFile.fileSize)} • {editingFile.mimeType || 'Unknown type'}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      Binary files cannot be edited inline. Choose a replacement file below — it
                      replaces the content on save (history is kept for rollback).
                    </p>
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Replace file</label>
                  <input
                    type="file"
                    onChange={(e) => setEditReplaceFile(e.target.files?.[0] || null)}
                    className="input"
                  />
                  {editReplaceFile && (
                    <p className="text-xs text-slate-500 mt-1">
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
            <div className="border border-slate-700 rounded-lg p-3 bg-slate-800/30">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-slate-400">
                  Rendered preview (fragments + content + placeholders)
                </span>
                <button
                  type="button"
                  onClick={handlePreview}
                  disabled={previewLoading}
                  className="btn btn-secondary text-xs py-1 px-2"
                >
                  {previewLoading ? 'Rendering…' : 'Preview'}
                </button>
              </div>
              {previewError && (
                <p className="text-xs text-yellow-400 mb-2">{previewError}</p>
              )}
              {previewContent !== null && (
                <pre className="bg-slate-950 rounded p-2 text-xs text-slate-200 font-mono whitespace-pre-wrap max-h-64 overflow-auto">
                  {previewContent}
                </pre>
              )}
              {previewContent === null && !previewError && (
                <p className="text-xs text-slate-500">
                  Click Preview to render this ConfigFile&apos;s fragments + content with
                  <code className="mx-1">{'${KEY}'}</code> placeholders resolved.
                </p>
              )}
            </div>
          )}
          <div>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={editAutoResync}
                onChange={(e) => setEditAutoResync(e.target.checked)}
              />
              <span>Auto re-sync when referenced values change</span>
            </label>
            <p className="text-xs text-slate-500 mt-1 ml-6">
              When a secret or variable referenced as <code>{'${KEY}'}</code> is updated, BRIDGEPORT will re-sync this file to all attached services.
            </p>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setEditingFile(null);
                setEditContent('');
                setEditDescription('');
                setEditReplaceFile(null);
              }}
              className="btn btn-ghost"
            >
              Cancel
            </button>
            <button onClick={handleEdit} disabled={savingEdit} className="btn btn-primary">
              {savingEdit ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </Modal>

      {/* View Modal */}
      <Modal
        isOpen={!!viewingFile}
        onClose={() => setViewingFile(null)}
        title={viewingFile?.name || ''}
        size="3xl"
      >
        {viewingFile && (
          <div className="flex flex-col" style={{ maxHeight: 'calc(90vh - 120px)' }}>
            <p className="text-sm text-slate-400 mb-4">
              {viewingFile.filename}
              {viewingFile.description && ` - ${viewingFile.description}`}
            </p>

            {/* Attached Services with Sync Status */}
            {viewingFile.services.length > 0 && (
              <div className="mb-4 p-3 bg-slate-800/50 rounded-lg">
                <p className="text-sm text-slate-400 mb-2">Attached to services:</p>
                <div className="space-y-1">
                  {viewingFile.services.map((sf) => {
                    const serverName =
                      sf.serviceDeployment?.server.name ??
                      sf.service.serviceDeployments?.[0]?.server.name ??
                      '—';
                    return (
                    <div key={sf.id} className="flex items-center gap-2 text-sm">
                      <span className="text-white">{serverName}</span>
                      <span className="text-slate-500">/</span>
                      <Link
                        to={`/services/${sf.service.id}`}
                        className="text-primary-400 hover:text-primary-300 hover:underline"
                      >
                        {sf.service.name}
                      </Link>
                      <span className="text-slate-500">→</span>
                      <code className="text-green-400 text-xs">{sf.targetPath}</code>
                      {sf.syncStatus && (
                        <span className={`ml-auto px-1.5 py-0.5 text-xs rounded ${getSyncStatusColor(sf.syncStatus)}`}>
                          {sf.syncStatus === 'synced' ? 'Synced' : sf.syncStatus === 'pending' ? 'Pending' : 'Never synced'}
                        </span>
                      )}
                    </div>
                    );
                  })}
                </div>
              </div>
            )}

            {viewingFile.isBinary ? (
              <div className="flex-1 flex items-center justify-center p-8 bg-slate-950 rounded-lg">
                <div className="text-center">
                  <svg className="w-16 h-16 text-slate-500 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="text-white font-medium mb-1">Binary File</p>
                  <p className="text-slate-400 text-sm">
                    {formatFileSize(viewingFile.fileSize)} • {viewingFile.mimeType || 'Unknown type'}
                  </p>
                  <p className="text-slate-500 text-xs mt-2">
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

            <div className="mt-4 flex justify-end gap-2">
              {!viewingFile.isBinary && viewingFile.content && (
                <button
                  onClick={() => navigator.clipboard.writeText(viewingFile.content!)}
                  className="btn btn-secondary"
                >
                  Copy Content
                </button>
              )}
              <button
                onClick={() => {
                  startEdit(viewingFile);
                  setViewingFile(null);
                }}
                className="btn btn-secondary"
              >
                Edit
              </button>
              <button onClick={() => setViewingFile(null)} className="btn btn-ghost">
                Close
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* History Modal */}
      <Modal
        isOpen={!!historyFile}
        onClose={() => {
          setHistoryFile(null);
          setHistory([]);
          setSelectedHistoryEntry(null);
        }}
        title={`History: ${historyFile?.name || ''}`}
        size="xl"
      >
        <p className="text-sm text-slate-400 mb-4">
          {history.length} previous version{history.length !== 1 ? 's' : ''}
        </p>

        {loadingHistory ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
          </div>
        ) : history.length === 0 ? (
          <div className="flex items-center justify-center text-slate-400 py-12">
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
                      ? 'bg-primary-900/30 border-primary-500'
                      : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'
                  }`}
                >
                  <p className="text-sm text-white">
                    {format(new Date(entry.editedAt), 'MMM d, yyyy')}
                  </p>
                  <p className="text-xs text-slate-400">
                    {format(new Date(entry.editedAt), 'h:mm a')}
                  </p>
                  {entry.editedBy && (
                    <p className="text-xs text-slate-500 mt-1 truncate">
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
                    <p className="text-sm text-slate-400">
                      Content at {format(new Date(selectedHistoryEntry.editedAt), 'MMM d, yyyy h:mm a')}
                    </p>
                    <button
                      onClick={() => setRestoreConfirm(selectedHistoryEntry)}
                      className="btn btn-primary text-sm"
                    >
                      Restore This Version
                    </button>
                  </div>
                  {historyFile?.isBinary ? (
                    <div className="flex-1 flex items-center justify-center p-8 bg-slate-950 rounded-lg text-slate-400">
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
                <div className="flex-1 flex items-center justify-center text-slate-400">
                  Select a version to preview
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Restore Confirmation */}
      <ConfirmDialog
        isOpen={!!restoreConfirm}
        onClose={() => setRestoreConfirm(null)}
        onConfirm={handleRestore}
        title="Restore Version"
        message="Are you sure you want to restore this version? The current content will be saved to history."
        confirmText="Restore"
        variant="warning"
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={!!deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={handleDelete}
        title="Delete Config File"
        message={`Are you sure you want to delete "${deleteConfirm?.name}"? This action cannot be undone.`}
        confirmText="Delete"
        variant="danger"
      />

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
        <label className="flex items-center gap-2 text-sm text-slate-400">
          <input
            type="checkbox"
            checked={configFilesAttachedFilter}
            onChange={(e) => setConfigFilesAttachedFilter(e.target.checked)}
            className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-primary-600 focus:ring-primary-500"
          />
          Only show files attached to services
        </label>
        {allServices.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Service:</span>
            <select
              value={configFilesServiceFilter || ''}
              onChange={(e) => setConfigFilesServiceFilter(e.target.value || null)}
              className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white"
            >
              <option value="">All Services</option>
              {allServices.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.serverName} / {service.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <span className="text-sm text-slate-500">
          ({filteredConfigFiles.length} of {configFiles.length} files)
        </span>
      </div>

      {/* Config Files Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredConfigFiles.map((file) => (
          <div key={file.id} className="panel hover:border-slate-600 transition-colors">
            <div className="flex items-start justify-between mb-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-white truncate">{file.name}</h3>
                  {file.isBinary && (
                    <span className="px-1.5 py-0.5 text-xs bg-purple-900/30 text-purple-400 rounded" title={file.mimeType || 'Binary file'}>
                      binary
                    </span>
                  )}
                </div>
                <p className="text-sm text-slate-400 truncate font-mono">{file.filename}</p>
                {file.isBinary && file.fileSize && (
                  <p className="text-xs text-slate-500">{formatFileSize(file.fileSize)}</p>
                )}
              </div>
              <div className="flex gap-1 ml-2">
                <button
                  onClick={() => handleView(file)}
                  className="p-1 text-slate-400 hover:text-white"
                  title="View"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                </button>
                <button
                  onClick={() => handleViewHistory(file)}
                  className="p-1 text-slate-400 hover:text-white"
                  title="History"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
                {file._count && file._count.services > 0 && (
                  <button
                    onClick={() => handleSyncAll(file)}
                    className="p-1 text-slate-400 hover:text-primary-400"
                    title="Sync to all services"
                  >
                    <RefreshIcon className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => setDeleteConfirm(file)}
                  className="p-1 text-slate-400 hover:text-red-400"
                  title="Delete"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
            {file.description && (
              <p className="text-xs text-slate-500 mb-2">{file.description}</p>
            )}
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>
                Updated {formatDistanceToNow(new Date(file.updatedAt), { addSuffix: true })}
              </span>
              <div className="flex items-center gap-2">
                {/* Sync Status Badge */}
                {file.syncStatus && file.syncStatus !== 'not_attached' && (
                  <span className={`px-1.5 py-0.5 rounded ${getSyncStatusColor(file.syncStatus)}`}>
                    {file.syncStatus === 'synced' ? 'Synced' :
                     file.syncStatus === 'pending' ? `${file.syncCounts?.pending || 0} pending` :
                     'Never synced'}
                  </span>
                )}
                {file._count && file._count.services > 0 && (
                  <span className="px-2 py-0.5 bg-primary-900/30 text-primary-400 rounded">
                    {file._count.services} service{file._count.services !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}

        {filteredConfigFiles.length === 0 && configFiles.length > 0 && (
          <div className="col-span-full panel text-center py-12">
            <p className="text-slate-400">No config files match the filter</p>
            <button
              onClick={() => {
                setConfigFilesAttachedFilter(false);
                setConfigFilesServiceFilter(null);
              }}
              className="btn btn-ghost mt-4"
            >
              Clear Filters
            </button>
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
        <Pagination
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
      <label className="block text-sm text-slate-400 mb-1">{label}</label>
      {selectedIds.length === 0 ? (
        <p className="text-xs text-slate-500 mb-2">
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
                className="flex items-center gap-2 bg-slate-800/50 border border-slate-700 rounded px-2 py-1.5"
              >
                <span className="text-xs text-slate-500 font-mono w-6 text-right">
                  {index + 1}.
                </span>
                <span className="text-sm font-mono text-white flex-1">
                  {fragment?.name ?? `(missing fragment ${id})`}
                </span>
                {fragment?.description && (
                  <span className="text-xs text-slate-500 truncate">
                    {fragment.description}
                  </span>
                )}
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    className="text-slate-500 hover:text-slate-200 disabled:opacity-30 px-1"
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === selectedIds.length - 1}
                    className="text-slate-500 hover:text-slate-200 disabled:opacity-30 px-1"
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    className="text-slate-500 hover:text-red-400 px-1"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {remaining.length > 0 ? (
        <select
          value=""
          onChange={(e) => {
            add(e.target.value);
            // Reset to placeholder so the select can be used multiple times.
            e.target.value = '';
          }}
          className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-white"
        >
          <option value="">Add fragment…</option>
          {remaining.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
              {f.description ? ` — ${f.description}` : ''}
            </option>
          ))}
        </select>
      ) : available.length > 0 ? (
        <p className="text-xs text-slate-500">All fragments are already included.</p>
      ) : (
        <p className="text-xs text-slate-500">
          No fragments defined in this environment yet — create one from the Fragments page.
        </p>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store.js';
import {
  listConfigFiles,
  getConfigFile,
  createConfigFile,
  updateConfigFile,
  deleteConfigFile,
  getConfigFileHistory,
  restoreConfigFile,
  uploadAssetFile,
  syncConfigFileToAll,
  type ConfigFile,
  type FileHistoryEntry,
  type ConfigFileSyncResult,
} from '../lib/api.js';
import { formatDistanceToNow, format } from 'date-fns';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { getSyncStatusColor } from '../lib/status.js';
import { RefreshIcon } from '../components/Icons.js';
import Pagination from '../components/Pagination.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { EmptyState } from '../components/EmptyState.js';
import { OperationResultsModal, type OperationResult } from '../components/OperationResultsModal.js';

interface ServiceOption {
  id: string;
  name: string;
  serverName: string;
}

export default function ConfigFiles() {
  const {
    selectedEnvironment,
    configFilesAttachedFilter,
    setConfigFilesAttachedFilter,
    configFilesServiceFilter,
    setConfigFilesServiceFilter,
  } = useAppStore();
  const [configFiles, setConfigFiles] = useState<ConfigFile[]>([]);
  const [allServices, setAllServices] = useState<ServiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFilename, setNewFilename] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingFile, setEditingFile] = useState<ConfigFile | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [viewingFile, setViewingFile] = useState<(ConfigFile & { services: Array<{ targetPath: string; service: { id: string; name: string; server: { id: string; name: string } } }> }) | null>(null);
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
  const [deleteConfirm, setDeleteConfirm] = useState<ConfigFile | null>(null);
  const [totalItems, setTotalItems] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      loadConfigFiles();
    }
  }, [selectedEnvironment?.id, currentPage, pageSize]);

  const loadConfigFiles = async () => {
    if (!selectedEnvironment?.id) return;
    setLoading(true);
    try {
      const offset = (currentPage - 1) * pageSize;
      const configFilesRes = await listConfigFiles(selectedEnvironment.id, { limit: pageSize, offset });
      setConfigFiles(configFilesRes.configFiles);
      setTotalItems(configFilesRes.total);

      // Build unique service options from config file attachments
      const serviceMap = new Map<string, ServiceOption>();
      for (const cf of configFilesRes.configFiles) {
        for (const sf of cf.services || []) {
          if (!serviceMap.has(sf.service.id)) {
            serviceMap.set(sf.service.id, {
              id: sf.service.id,
              name: sf.service.name,
              serverName: sf.service.server.name,
            });
          }
        }
      }
      // Sort by server name then service name
      const serviceOptions = Array.from(serviceMap.values()).sort((a, b) =>
        `${a.serverName}/${a.name}`.localeCompare(`${b.serverName}/${b.name}`)
      );
      setAllServices(serviceOptions);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;
    setCreating(true);
    try {
      await createConfigFile(selectedEnvironment.id, {
        name: newName,
        filename: newFilename,
        content: newContent,
        description: newDescription || undefined,
      });
      await loadConfigFiles();
      setShowCreate(false);
      setNewName('');
      setNewFilename('');
      setNewContent('');
      setNewDescription('');
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = async () => {
    if (!editingFile) return;
    await updateConfigFile(editingFile.id, {
      content: editContent,
      description: editDescription || undefined,
    });
    setEditingFile(null);
    setEditContent('');
    setEditDescription('');
    await loadConfigFiles();
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await deleteConfigFile(deleteConfirm.id);
    setDeleteConfirm(null);
    await loadConfigFiles();
  };

  const handleSyncAll = async (file: ConfigFile) => {
    setSyncingFile(file);
    setSyncResults(null);
    try {
      const { results } = await syncConfigFileToAll(file.id);
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
      // Reload config files to update sync status
      await loadConfigFiles();
    } catch (err) {
      setSyncResults([{
        id: 'error',
        label: 'Sync failed',
        success: false,
        error: err instanceof Error ? err.message : 'Sync failed',
      }]);
    }
  };

  const handleView = async (file: ConfigFile) => {
    const { configFile } = await getConfigFile(file.id);
    setViewingFile(configFile);
  };

  const startEdit = (file: ConfigFile) => {
    setEditingFile(file);
    setEditContent(file.content || '');
    setEditDescription(file.description || '');
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
    await loadConfigFiles();
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
      await loadConfigFiles();
      setShowUpload(false);
      setUploadFile(null);
      setUploadName('');
      setUploadFilename('');
      setUploadDescription('');
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

  const totalPages = Math.ceil(totalItems / pageSize);

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
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Manage config files (compose files, Caddyfiles, certificates) for {selectedEnvironment.name}
        </p>
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
          setNewName('');
          setNewFilename('');
          setNewContent('');
          setNewDescription('');
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
            <label className="block text-sm text-slate-400 mb-1">Content</label>
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Paste file content here..."
              rows={15}
              className="input font-mono text-sm"
              required
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                setNewName('');
                setNewFilename('');
                setNewContent('');
                setNewDescription('');
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
            <label className="block text-sm text-slate-400 mb-1">Content</label>
            {editingFile?.isBinary ? (
              <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700">
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
                      Binary files cannot be edited. Re-upload to replace.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={20}
                className="input font-mono text-sm"
                autoFocus
              />
            )}
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setEditingFile(null);
                setEditContent('');
                setEditDescription('');
              }}
              className="btn btn-ghost"
            >
              Cancel
            </button>
            <button onClick={handleEdit} className="btn btn-primary">
              Save Changes
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
                  {viewingFile.services.map((sf) => (
                    <div key={sf.service.id} className="flex items-center gap-2 text-sm">
                      <span className="text-white">{sf.service.server.name}</span>
                      <span className="text-slate-500">/</span>
                      <span className="text-primary-400">{sf.service.name}</span>
                      <span className="text-slate-500">→</span>
                      <code className="text-green-400 text-xs">{sf.targetPath}</code>
                      {sf.syncStatus && (
                        <span className={`ml-auto px-1.5 py-0.5 text-xs rounded ${getSyncStatusColor(sf.syncStatus)}`}>
                          {sf.syncStatus === 'synced' ? 'Synced' : sf.syncStatus === 'pending' ? 'Pending' : 'Never synced'}
                        </span>
                      )}
                    </div>
                  ))}
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
              <pre className="flex-1 overflow-auto p-4 bg-slate-950 rounded-lg text-sm font-mono text-slate-300">
                {viewingFile.content || ''}
              </pre>
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
                    <pre className="flex-1 overflow-auto p-4 bg-slate-950 rounded-lg text-sm font-mono text-slate-300">
                      {selectedHistoryEntry.content || ''}
                    </pre>
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
        }}
        title={`Sync: ${syncingFile?.name || ''}`}
        loadingMessage="Syncing to all attached services..."
        results={syncResults}
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

        {totalItems === 0 && (
          <div className="col-span-full">
            <EmptyState
              message="No config files yet"
              description="Store docker-compose files, Caddyfiles, certificates, and more"
              action={{ label: 'Create First Config File', onClick: () => setShowCreate(true) }}
            />
          </div>
        )}
      </div>
      {totalItems > 0 && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={totalItems}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
        />
      )}
    </div>
  );
}

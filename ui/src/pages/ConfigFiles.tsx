import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';
import {
  listConfigFiles,
  getConfigFile,
  createConfigFile,
  updateConfigFile,
  deleteConfigFile,
  getConfigFileHistory,
  restoreConfigFile,
  listServers,
  type ConfigFile,
  type FileHistoryEntry,
  type Server,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';

interface ConfigFileWithServers extends ConfigFile {
  servers?: string[]; // Derived from services
}

export default function ConfigFiles() {
  const { selectedEnvironment } = useAppStore();
  const [configFiles, setConfigFiles] = useState<ConfigFileWithServers[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
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
  const [serviceFilter, setServiceFilter] = useState<string>('');
  const [serverFilter, setServerFilter] = useState<string>('');

  useEffect(() => {
    if (selectedEnvironment?.id) {
      loadConfigFiles();
    }
  }, [selectedEnvironment?.id]);

  const loadConfigFiles = async () => {
    if (!selectedEnvironment?.id) return;
    setLoading(true);
    try {
      const [configFilesRes, serversRes] = await Promise.all([
        listConfigFiles(selectedEnvironment.id),
        listServers(selectedEnvironment.id),
      ]);
      setConfigFiles(configFilesRes.configFiles);
      setServers(serversRes.servers);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;
    setCreating(true);
    try {
      const { configFile } = await createConfigFile(selectedEnvironment.id, {
        name: newName,
        filename: newFilename,
        content: newContent,
        description: newDescription || undefined,
      });
      setConfigFiles((prev) => [...prev, configFile]);
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
    const { configFile } = await updateConfigFile(editingFile.id, {
      content: editContent,
      description: editDescription || undefined,
    });
    setConfigFiles((prev) =>
      prev.map((f) => (f.id === configFile.id ? { ...configFile, _count: f._count } : f))
    );
    setEditingFile(null);
    setEditContent('');
    setEditDescription('');
  };

  const handleDelete = async (file: ConfigFile) => {
    if (!confirm(`Are you sure you want to delete "${file.name}"?`)) return;
    await deleteConfigFile(file.id);
    setConfigFiles((prev) => prev.filter((f) => f.id !== file.id));
  };

  const handleView = async (file: ConfigFile) => {
    const { configFile } = await getConfigFile(file.id);
    setViewingFile(configFile);
  };

  const startEdit = (file: ConfigFile) => {
    setEditingFile(file);
    setEditContent(file.content);
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

  const handleRestore = async (historyEntry: FileHistoryEntry) => {
    if (!historyFile) return;
    if (!confirm('Are you sure you want to restore this version? The current content will be saved to history.')) return;

    const { configFile } = await restoreConfigFile(historyFile.id, historyEntry.id);
    setConfigFiles((prev) =>
      prev.map((f) => (f.id === configFile.id ? { ...configFile, _count: f._count } : f))
    );
    // Reload history to show the new entry
    const { history: updatedHistory } = await getConfigFileHistory(historyFile.id);
    setHistory(updatedHistory);
    setSelectedHistoryEntry(null);
  };

  // Filter config files based on filters
  // Note: For server filtering, we need to fetch the file details to know which servers it's attached to
  // For now, we filter based on service count and allow viewing individual files to see server assignments
  const filteredConfigFiles = configFiles.filter((f) => {
    // Service attachment filter
    if (serviceFilter && (!f._count || f._count.services === 0)) {
      return false;
    }
    return true;
  });

  if (!selectedEnvironment) {
    return (
      <div className="p-8">
        <div className="card text-center py-12">
          <p className="text-slate-400">Please select an environment</p>
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
          <h1 className="text-2xl font-bold text-white">Config Files</h1>
          <p className="text-slate-400">
            Manage config files (compose files, Caddyfiles, certificates) for {selectedEnvironment.name}
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn btn-primary">
          New Config File
        </button>
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-3xl p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-white mb-4">New Config File</h3>
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
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingFile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-3xl p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-white mb-4">
              Edit: {editingFile.name}
            </h3>
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
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={20}
                  className="input font-mono text-sm"
                  autoFocus
                />
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
          </div>
        </div>
      )}

      {/* View Modal */}
      {viewingFile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-3xl p-6 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-white">{viewingFile.name}</h3>
                <p className="text-sm text-slate-400">
                  {viewingFile.filename}
                  {viewingFile.description && ` - ${viewingFile.description}`}
                </p>
              </div>
              <button
                onClick={() => setViewingFile(null)}
                className="text-slate-400 hover:text-white"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Attached Services */}
            {viewingFile.services.length > 0 && (
              <div className="mb-4 p-3 bg-slate-800/50 rounded-lg">
                <p className="text-sm text-slate-400 mb-2">Attached to services:</p>
                <div className="space-y-1">
                  {viewingFile.services
                    .filter((sf) => !serverFilter || sf.service.server.id === serverFilter)
                    .map((sf) => (
                      <div key={sf.service.id} className="text-sm">
                        <span className="text-white">{sf.service.server.name}</span>
                        <span className="text-slate-500"> / </span>
                        <span className="text-primary-400">{sf.service.name}</span>
                        <span className="text-slate-500"> → </span>
                        <code className="text-green-400 text-xs">{sf.targetPath}</code>
                      </div>
                    ))}
                  {serverFilter && viewingFile.services.filter((sf) => sf.service.server.id === serverFilter).length === 0 && (
                    <p className="text-sm text-slate-500">Not attached to any services on this server</p>
                  )}
                </div>
              </div>
            )}

            <pre className="flex-1 overflow-auto p-4 bg-slate-950 rounded-lg text-sm font-mono text-slate-300">
              {viewingFile.content}
            </pre>

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => navigator.clipboard.writeText(viewingFile.content)}
                className="btn btn-secondary"
              >
                Copy Content
              </button>
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
        </div>
      )}

      {/* History Modal */}
      {historyFile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-5xl p-6 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-white">
                  History: {historyFile.name}
                </h3>
                <p className="text-sm text-slate-400">
                  {history.length} previous version{history.length !== 1 ? 's' : ''}
                </p>
              </div>
              <button
                onClick={() => {
                  setHistoryFile(null);
                  setHistory([]);
                  setSelectedHistoryEntry(null);
                }}
                className="text-slate-400 hover:text-white"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {loadingHistory ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
              </div>
            ) : history.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-slate-400">
                No edit history available
              </div>
            ) : (
              <div className="flex-1 flex gap-4 overflow-hidden">
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
                          onClick={() => handleRestore(selectedHistoryEntry)}
                          className="btn btn-primary text-sm"
                        >
                          Restore This Version
                        </button>
                      </div>
                      <pre className="flex-1 overflow-auto p-4 bg-slate-950 rounded-lg text-sm font-mono text-slate-300">
                        {selectedHistoryEntry.content}
                      </pre>
                    </>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-slate-400">
                      Select a version to preview
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="mb-6 flex items-center gap-6 flex-wrap">
        <label className="flex items-center gap-2 text-sm text-slate-400">
          <input
            type="checkbox"
            checked={!!serviceFilter}
            onChange={(e) => setServiceFilter(e.target.checked ? 'attached' : '')}
            className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-primary-600 focus:ring-primary-500"
          />
          Only show files attached to services
        </label>
        {servers.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Server:</span>
            <select
              value={serverFilter}
              onChange={(e) => setServerFilter(e.target.value)}
              className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white"
            >
              <option value="">All Servers</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
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
          <div key={file.id} className="card hover:border-slate-600 transition-colors">
            <div className="flex items-start justify-between mb-2">
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-white truncate">{file.name}</h3>
                <p className="text-sm text-slate-400 truncate font-mono">{file.filename}</p>
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
                  onClick={() => startEdit(file)}
                  className="p-1 text-slate-400 hover:text-white"
                  title="Edit"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
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
                <button
                  onClick={() => handleDelete(file)}
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
              {file._count && file._count.services > 0 && (
                <span className="px-2 py-0.5 bg-primary-900/30 text-primary-400 rounded">
                  {file._count.services} service{file._count.services !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
        ))}

        {filteredConfigFiles.length === 0 && configFiles.length > 0 && (
          <div className="col-span-full card text-center py-12">
            <p className="text-slate-400">No config files match the filter</p>
            <button
              onClick={() => setServiceFilter('')}
              className="btn btn-ghost mt-4"
            >
              Clear Filter
            </button>
          </div>
        )}

        {configFiles.length === 0 && (
          <div className="col-span-full card text-center py-12">
            <p className="text-slate-400">No config files yet</p>
            <p className="text-slate-500 text-sm mt-2">
              Store docker-compose files, Caddyfiles, certificates, and more
            </p>
            <button onClick={() => setShowCreate(true)} className="btn btn-primary mt-4">
              Create First Config File
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

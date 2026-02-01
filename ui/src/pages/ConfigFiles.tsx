import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';
import {
  listConfigFiles,
  getConfigFile,
  createConfigFile,
  updateConfigFile,
  deleteConfigFile,
  type ConfigFile,
} from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

export default function ConfigFiles() {
  const { selectedEnvironment } = useAppStore();
  const [configFiles, setConfigFiles] = useState<ConfigFile[]>([]);
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

  useEffect(() => {
    if (selectedEnvironment?.id) {
      loadConfigFiles();
    }
  }, [selectedEnvironment?.id]);

  const loadConfigFiles = async () => {
    if (!selectedEnvironment?.id) return;
    setLoading(true);
    try {
      const { configFiles } = await listConfigFiles(selectedEnvironment.id);
      setConfigFiles(configFiles);
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
                  {viewingFile.services.map((sf) => (
                    <div key={sf.service.id} className="text-sm">
                      <span className="text-white">{sf.service.server.name}</span>
                      <span className="text-slate-500"> / </span>
                      <span className="text-primary-400">{sf.service.name}</span>
                      <span className="text-slate-500"> → </span>
                      <code className="text-green-400 text-xs">{sf.targetPath}</code>
                    </div>
                  ))}
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

      {/* Config Files Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {configFiles.map((file) => (
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

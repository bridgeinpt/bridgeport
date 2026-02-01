import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';
import {
  listEnvTemplates,
  createEnvTemplate,
  updateEnvTemplate,
  deleteEnvTemplate,
  generateEnvPreview,
  listSecrets,
  getEnvTemplateHistory,
  restoreEnvTemplate,
  type EnvTemplate,
  type Secret,
  type FileHistoryEntry,
} from '../lib/api';
import { formatDistanceToNow, format } from 'date-fns';

export default function EnvTemplates() {
  const { selectedEnvironment } = useAppStore();
  const [templates, setTemplates] = useState<EnvTemplate[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [previewTemplate, setPreviewTemplate] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [historyTemplate, setHistoryTemplate] = useState<EnvTemplate | null>(null);
  const [history, setHistory] = useState<FileHistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [selectedHistoryEntry, setSelectedHistoryEntry] = useState<FileHistoryEntry | null>(null);

  useEffect(() => {
    loadData();
  }, [selectedEnvironment?.id]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [templatesRes, secretsRes] = await Promise.all([
        listEnvTemplates(),
        selectedEnvironment?.id ? listSecrets(selectedEnvironment.id) : { secrets: [] },
      ]);
      setTemplates(templatesRes.templates);
      setSecrets(secretsRes.secrets);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const { template } = await createEnvTemplate({
        name: newName,
        template: newTemplate,
      });
      setTemplates((prev) => [...prev, template]);
      setShowCreate(false);
      setNewName('');
      setNewTemplate('');
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = async (templateName: string) => {
    if (!editContent) return;
    await updateEnvTemplate(templateName, editContent);
    setTemplates((prev) =>
      prev.map((t) =>
        t.name === templateName ? { ...t, template: editContent, updatedAt: new Date().toISOString() } : t
      )
    );
    setEditingTemplate(null);
    setEditContent('');
  };

  const handleDelete = async (templateName: string) => {
    if (!confirm(`Are you sure you want to delete the template "${templateName}"?`)) return;
    await deleteEnvTemplate(templateName);
    setTemplates((prev) => prev.filter((t) => t.name !== templateName));
  };

  const handlePreview = async (templateName: string) => {
    if (!selectedEnvironment?.id) {
      setPreviewError('Please select an environment first');
      return;
    }
    setPreviewTemplate(templateName);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const { content } = await generateEnvPreview(selectedEnvironment.id, templateName);
      setPreviewContent(content);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Preview failed');
      setPreviewContent('');
    } finally {
      setPreviewLoading(false);
    }
  };

  const startEdit = (template: EnvTemplate) => {
    setEditingTemplate(template.name);
    setEditContent(template.template);
  };

  const handleViewHistory = async (template: EnvTemplate) => {
    setHistoryTemplate(template);
    setLoadingHistory(true);
    try {
      const { history } = await getEnvTemplateHistory(template.name);
      setHistory(history);
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleRestore = async (historyEntry: FileHistoryEntry) => {
    if (!historyTemplate) return;
    if (!confirm('Are you sure you want to restore this version? The current content will be saved to history.')) return;

    const { template } = await restoreEnvTemplate(historyTemplate.name, historyEntry.id);
    setTemplates((prev) =>
      prev.map((t) => (t.name === template.name ? template : t))
    );
    // Reload history to show the new entry
    const { history: updatedHistory } = await getEnvTemplateHistory(historyTemplate.name);
    setHistory(updatedHistory);
    setSelectedHistoryEntry(null);
  };

  // Extract placeholders from template
  const extractPlaceholders = (template: string): string[] => {
    const matches = template.match(/\$\{([A-Z][A-Z0-9_]*)\}/g) || [];
    return [...new Set(matches.map((m) => m.slice(2, -1)))];
  };

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
          <h1 className="text-2xl font-bold text-white">Env Templates</h1>
          <p className="text-slate-400">
            Templates for generating .env files with secret substitution
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn btn-primary">
          New Template
        </button>
      </div>

      {/* Available Secrets Reference */}
      {secrets.length > 0 && (
        <div className="mb-6 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
          <p className="text-sm text-slate-400 mb-2">
            Available secrets in <span className="text-white">{selectedEnvironment?.name}</span>:
          </p>
          <div className="flex flex-wrap gap-2">
            {secrets.map((secret) => (
              <code
                key={secret.id}
                className="px-2 py-1 bg-slate-900 rounded text-xs text-green-400 cursor-pointer hover:bg-slate-700"
                onClick={() => navigator.clipboard.writeText(`\${${secret.key}}`)}
                title="Click to copy"
              >
                ${'{'}
                {secret.key}
                {'}'}
              </code>
            ))}
          </div>
        </div>
      )}

      {/* Create Template Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-2xl p-6">
            <h3 className="text-lg font-semibold text-white mb-4">New Env Template</h3>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Template Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                  placeholder="app-api"
                  className="input"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">
                  Lowercase with hyphens (e.g., app-api, keycloak)
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Template Content</label>
                <textarea
                  value={newTemplate}
                  onChange={(e) => setNewTemplate(e.target.value)}
                  placeholder={`DATABASE_URL=\${DATABASE_URL}\nDJANGO_SECRET_KEY=\${DJANGO_SECRET_KEY}\nDEBUG=false`}
                  rows={10}
                  className="input font-mono text-sm"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">
                  Use {'${SECRET_NAME}'} for secret placeholders
                </p>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    setNewName('');
                    setNewTemplate('');
                  }}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={creating} className="btn btn-primary">
                  {creating ? 'Creating...' : 'Create Template'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewTemplate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-2xl p-6 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">
                Preview: {previewTemplate}
              </h3>
              <button
                onClick={() => {
                  setPreviewTemplate(null);
                  setPreviewContent('');
                  setPreviewError(null);
                }}
                className="text-slate-400 hover:text-white"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-sm text-slate-400 mb-4">
              Generated .env for <span className="text-white">{selectedEnvironment?.name}</span>
            </p>
            {previewLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
              </div>
            ) : previewError ? (
              <div className="p-4 bg-red-900/20 border border-red-700 rounded-lg text-red-400">
                {previewError}
              </div>
            ) : (
              <pre className="flex-1 overflow-auto p-4 bg-slate-950 rounded-lg text-sm font-mono text-green-400">
                {previewContent}
              </pre>
            )}
            <div className="mt-4 flex justify-end gap-2">
              {previewContent && (
                <button
                  onClick={() => navigator.clipboard.writeText(previewContent)}
                  className="btn btn-secondary"
                >
                  Copy to Clipboard
                </button>
              )}
              <button
                onClick={() => {
                  setPreviewTemplate(null);
                  setPreviewContent('');
                  setPreviewError(null);
                }}
                className="btn btn-ghost"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History Modal */}
      {historyTemplate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-5xl p-6 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-white">
                  History: {historyTemplate.name}
                </h3>
                <p className="text-sm text-slate-400">
                  {history.length} previous version{history.length !== 1 ? 's' : ''}
                </p>
              </div>
              <button
                onClick={() => {
                  setHistoryTemplate(null);
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

      {/* Templates List */}
      <div className="space-y-4">
        {templates.map((template) => {
          const placeholders = extractPlaceholders(template.template);
          const isEditing = editingTemplate === template.name;

          return (
            <div key={template.id} className="card">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-mono text-white font-medium text-lg">{template.name}</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Updated {formatDistanceToNow(new Date(template.updatedAt), { addSuffix: true })}
                  </p>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => handlePreview(template.name)} className="btn btn-ghost text-sm">
                    Preview
                  </button>
                  <button
                    onClick={() => (isEditing ? handleEdit(template.name) : startEdit(template))}
                    className="btn btn-ghost text-sm"
                  >
                    {isEditing ? 'Save' : 'Edit'}
                  </button>
                  {isEditing && (
                    <button
                      onClick={() => {
                        setEditingTemplate(null);
                        setEditContent('');
                      }}
                      className="btn btn-ghost text-sm"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={() => handleViewHistory(template)}
                    className="btn btn-ghost text-sm"
                  >
                    History
                  </button>
                  <button
                    onClick={() => handleDelete(template.name)}
                    className="btn btn-ghost text-sm text-red-400 hover:text-red-300"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Placeholders */}
              {placeholders.length > 0 && (
                <div className="mb-3">
                  <span className="text-xs text-slate-500">Uses secrets: </span>
                  <span className="text-xs">
                    {placeholders.map((p, i) => (
                      <span key={p}>
                        <code className="text-yellow-400">{p}</code>
                        {i < placeholders.length - 1 && ', '}
                      </span>
                    ))}
                  </span>
                </div>
              )}

              {/* Template Content */}
              {isEditing ? (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={12}
                  className="input font-mono text-sm"
                  autoFocus
                />
              ) : (
                <pre className="p-3 bg-slate-950 rounded-lg text-sm font-mono text-slate-300 overflow-x-auto max-h-48">
                  {template.template}
                </pre>
              )}
            </div>
          );
        })}

        {templates.length === 0 && (
          <div className="card text-center py-12">
            <p className="text-slate-400">No env templates configured</p>
            <p className="text-slate-500 text-sm mt-2">
              Templates let you generate .env files with secret substitution
            </p>
            <button onClick={() => setShowCreate(true)} className="btn btn-primary mt-4">
              Create First Template
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

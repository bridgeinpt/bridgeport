import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';
import {
  listSecrets,
  createSecret,
  getSecretValue,
  updateSecret,
  deleteSecret,
  type Secret,
} from '../lib/api';
import { formatDistanceToNow } from 'date-fns';

export default function Secrets() {
  const { selectedEnvironment } = useAppStore();
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [editingSecret, setEditingSecret] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      listSecrets(selectedEnvironment.id)
        .then(({ secrets }) => setSecrets(secrets))
        .finally(() => setLoading(false));
    }
  }, [selectedEnvironment?.id]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;

    setCreating(true);
    try {
      const { secret } = await createSecret(selectedEnvironment.id, {
        key: newKey,
        value: newValue,
        description: newDescription || undefined,
      });
      setSecrets((prev) => [...prev, secret]);
      setShowCreate(false);
      setNewKey('');
      setNewValue('');
      setNewDescription('');
    } finally {
      setCreating(false);
    }
  };

  const handleReveal = async (secretId: string) => {
    if (revealedSecrets[secretId]) {
      setRevealedSecrets((prev) => {
        const next = { ...prev };
        delete next[secretId];
        return next;
      });
      return;
    }

    const { value } = await getSecretValue(secretId);
    setRevealedSecrets((prev) => ({ ...prev, [secretId]: value }));
  };

  const handleEdit = async (secretId: string) => {
    if (!editValue) return;

    await updateSecret(secretId, { value: editValue });
    setEditingSecret(null);
    setEditValue('');
    // Remove from revealed
    setRevealedSecrets((prev) => {
      const next = { ...prev };
      delete next[secretId];
      return next;
    });
  };

  const handleDelete = async (secretId: string) => {
    if (!confirm('Are you sure you want to delete this secret?')) return;

    await deleteSecret(secretId);
    setSecrets((prev) => prev.filter((s) => s.id !== secretId));
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 w-32 bg-slate-700 rounded mb-8"></div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-slate-800 rounded-xl"></div>
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
          <h1 className="text-2xl font-bold text-white">Secrets</h1>
          <p className="text-slate-400">
            Encrypted secrets for {selectedEnvironment?.name}
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn btn-primary">
          Add Secret
        </button>
      </div>

      {/* Create Secret Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Add Secret</h3>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Key</label>
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value.toUpperCase())}
                  placeholder="DATABASE_URL"
                  pattern="^[A-Z][A-Z0-9_]*$"
                  className="input"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">
                  Uppercase with underscores (e.g., API_KEY)
                </p>
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Value</label>
                <textarea
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder="Secret value..."
                  rows={3}
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Description (optional)
                </label>
                <input
                  type="text"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="What is this secret for?"
                  className="input"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="btn btn-primary"
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Secrets List */}
      <div className="space-y-3">
        {secrets.map((secret) => (
          <div key={secret.id} className="card">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <h3 className="font-mono text-white font-medium">{secret.key}</h3>
                  {secret.description && (
                    <span className="text-sm text-slate-400">
                      - {secret.description}
                    </span>
                  )}
                </div>

                {editingSecret === secret.id ? (
                  <div className="mt-3 flex gap-2">
                    <input
                      type="password"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      placeholder="New value..."
                      className="input flex-1"
                      autoFocus
                    />
                    <button
                      onClick={() => handleEdit(secret.id)}
                      className="btn btn-primary text-sm"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditingSecret(null);
                        setEditValue('');
                      }}
                      className="btn btn-ghost text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                ) : revealedSecrets[secret.id] ? (
                  <pre className="mt-2 p-2 bg-slate-950 rounded text-sm font-mono text-green-400 overflow-x-auto">
                    {revealedSecrets[secret.id]}
                  </pre>
                ) : (
                  <p className="mt-1 text-slate-500 font-mono text-sm">
                    ••••••••••••••••
                  </p>
                )}

                <p className="mt-2 text-xs text-slate-500">
                  Updated{' '}
                  {formatDistanceToNow(new Date(secret.updatedAt), {
                    addSuffix: true,
                  })}
                </p>
              </div>

              <div className="flex gap-1">
                <button
                  onClick={() => handleReveal(secret.id)}
                  className="btn btn-ghost text-sm"
                >
                  {revealedSecrets[secret.id] ? 'Hide' : 'Reveal'}
                </button>
                <button
                  onClick={() => {
                    setEditingSecret(secret.id);
                    setEditValue('');
                  }}
                  className="btn btn-ghost text-sm"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(secret.id)}
                  className="btn btn-ghost text-sm text-red-400 hover:text-red-300"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}

        {secrets.length === 0 && (
          <div className="card text-center py-12">
            <p className="text-slate-400">No secrets configured</p>
            <button
              onClick={() => setShowCreate(true)}
              className="btn btn-primary mt-4"
            >
              Add First Secret
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

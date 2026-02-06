import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store.js';
import {
  listSecrets,
  createSecret,
  getSecretValue,
  updateSecret,
  deleteSecret,
  getModuleSettings,
  type Secret,
} from '../lib/api.js';
import { formatDistanceToNow } from 'date-fns';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { LockIcon, LinkIcon, WarningIcon, PencilIcon, TrashIcon } from '../components/Icons.js';
import Pagination from '../components/Pagination.js';
import { usePagination } from '../hooks/usePagination.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { EmptyState } from '../components/EmptyState.js';

export default function Secrets() {
  const { selectedEnvironment } = useAppStore();
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newNeverReveal, setNewNeverReveal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({});
  const [editingSecret, setEditingSecret] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<Secret | null>(null);
  const [expandedUsage, setExpandedUsage] = useState<Record<string, boolean>>({});

  // Environment settings (for reveal permission check)
  const [allowSecretReveal, setAllowSecretReveal] = useState(true);

  useEffect(() => {
    if (selectedEnvironment?.id) {
      setLoading(true);
      Promise.all([
        listSecrets(selectedEnvironment.id),
        getModuleSettings(selectedEnvironment.id, 'general'),
      ])
        .then(([secretsRes, settingsRes]) => {
          setSecrets(secretsRes.secrets);
          setAllowSecretReveal(settingsRes.settings.allowSecretReveal as boolean);
        })
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
        neverReveal: newNeverReveal,
      });
      setSecrets((prev) => [...prev, secret]);
      setShowCreate(false);
      setNewKey('');
      setNewValue('');
      setNewDescription('');
      setNewNeverReveal(false);
    } finally {
      setCreating(false);
    }
  };

  const handleReveal = async (secret: Secret) => {
    if (revealedSecrets[secret.id]) {
      setRevealedSecrets((prev) => {
        const next = { ...prev };
        delete next[secret.id];
        return next;
      });
      setRevealErrors((prev) => {
        const next = { ...prev };
        delete next[secret.id];
        return next;
      });
      return;
    }

    try {
      const { value } = await getSecretValue(secret.id);
      setRevealedSecrets((prev) => ({ ...prev, [secret.id]: value }));
      setRevealErrors((prev) => {
        const next = { ...prev };
        delete next[secret.id];
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reveal secret';
      setRevealErrors((prev) => ({ ...prev, [secret.id]: message }));
    }
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

  const handleDelete = async () => {
    if (!deleteConfirm) return;

    await deleteSecret(deleteConfirm.id);
    setSecrets((prev) => prev.filter((s) => s.id !== deleteConfirm.id));
    setDeleteConfirm(null);
  };

  const canReveal = (secret: Secret) => {
    return allowSecretReveal && !secret.neverReveal;
  };

  const toggleUsageExpanded = (secretId: string) => {
    setExpandedUsage((prev) => ({ ...prev, [secretId]: !prev[secretId] }));
  };

  // Pagination
  const {
    paginatedData,
    currentPage,
    totalPages,
    totalItems,
    pageSize,
    setPage,
    setPageSize,
  } = usePagination({ data: secrets, defaultPageSize: 25 });

  if (loading) {
    return <LoadingSkeleton rows={3} rowHeight="h-16" />;
  }

  // Find unused secrets for the warning banner
  const unusedSecrets = secrets.filter((s) => (s.usageCount ?? 0) === 0);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-slate-400">
          Encrypted secrets for {selectedEnvironment?.name}
        </p>
        <button onClick={() => setShowCreate(true)} className="btn btn-primary">
          Add Secret
        </button>
      </div>

      {/* Unused Secrets Warning */}
      {unusedSecrets.length > 0 && (
        <div className="mb-5 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
          <div className="flex items-start gap-3">
            <WarningIcon className="w-5 h-5 text-yellow-400 mt-0.5" />
            <div>
              <h4 className="text-yellow-400 font-medium">
                {unusedSecrets.length} Unused Secret{unusedSecrets.length > 1 ? 's' : ''}
              </h4>
              <p className="text-yellow-300/80 text-sm mt-1">
                These secrets are not referenced in any config files. They may be candidates for cleanup.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Create Secret Modal */}
      <Modal
        isOpen={showCreate}
        onClose={() => {
          setShowCreate(false);
          setNewNeverReveal(false);
        }}
        title="Add Secret"
        size="md"
      >
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
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="neverReveal"
              checked={newNeverReveal}
              onChange={(e) => setNewNeverReveal(e.target.checked)}
              className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-primary-600 focus:ring-primary-500"
            />
            <label htmlFor="neverReveal" className="text-sm text-slate-300">
              Write-only (cannot be revealed after creation)
            </label>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                setNewNeverReveal(false);
              }}
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
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={!!deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={handleDelete}
        title="Delete Secret"
        message={`Are you sure you want to delete "${deleteConfirm?.key}"? This action cannot be undone.`}
        confirmText="Delete"
        variant="danger"
      />

      {/* Secrets List */}
      <div className="space-y-3">
        {paginatedData.map((secret) => (
          <div
            key={secret.id}
            className={`panel ${(secret.usageCount ?? 0) === 0 ? 'border-yellow-500/30' : ''}`}
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3 flex-wrap">
                  <h3 className="font-mono text-white font-medium">{secret.key}</h3>
                  {secret.neverReveal && (
                    <span className="flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                      <LockIcon className="w-3 h-3" />
                      Write-only
                    </span>
                  )}
                  {secret.description && (
                    <span className="text-sm text-slate-400">
                      - {secret.description}
                    </span>
                  )}
                </div>

                {/* Usage Info */}
                <div className="mt-2">
                  {(secret.usageCount ?? 0) > 0 ? (
                    <div>
                      <button
                        onClick={() => toggleUsageExpanded(secret.id)}
                        className="flex items-center gap-1.5 text-sm text-primary-400 hover:text-primary-300"
                      >
                        <LinkIcon className="w-3.5 h-3.5" />
                        Used by {secret.usageCount} service{secret.usageCount !== 1 ? 's' : ''}
                        <svg
                          className={`w-4 h-4 transition-transform ${expandedUsage[secret.id] ? 'rotate-180' : ''}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {expandedUsage[secret.id] && secret.usedByServices && (
                        <div className="mt-2 pl-5 space-y-1">
                          {secret.usedByServices.map((service) => (
                            <Link
                              key={service.id}
                              to={`/services/${service.id}`}
                              className="block text-sm text-slate-300 hover:text-white"
                            >
                              <span className="text-slate-500">{service.serverName} /</span> {service.name}
                            </Link>
                          ))}
                          {secret.usedByConfigFiles && secret.usedByConfigFiles.length > 0 && (
                            <div className="mt-2 text-xs text-slate-500">
                              Referenced in: {secret.usedByConfigFiles.map((f) => f.name).join(', ')}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-sm text-yellow-400/80 flex items-center gap-1.5">
                      <WarningIcon className="w-3.5 h-3.5" />
                      Not used in any config files
                    </span>
                  )}
                </div>

                {editingSecret === secret.id ? (
                  <div className="mt-3 space-y-2">
                    <textarea
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      placeholder="New value..."
                      rows={3}
                      className="input w-full font-mono text-sm"
                      autoFocus
                    />
                    <div className="flex gap-2">
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
                  </div>
                ) : revealErrors[secret.id] ? (
                  <p className="mt-2 text-sm text-red-400">{revealErrors[secret.id]}</p>
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

              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleReveal(secret)}
                  disabled={!canReveal(secret)}
                  className={`btn btn-ghost text-sm ${
                    !canReveal(secret) ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                  title={
                    !allowSecretReveal
                      ? 'Reveal is disabled for this environment'
                      : secret.neverReveal
                      ? 'This secret is write-only'
                      : undefined
                  }
                >
                  {revealedSecrets[secret.id] ? 'Hide' : 'Reveal'}
                </button>
                <button
                  onClick={() => {
                    setEditingSecret(secret.id);
                    setEditValue('');
                  }}
                  className="p-1.5 text-slate-400 hover:text-white rounded"
                  title="Edit"
                >
                  <PencilIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setDeleteConfirm(secret)}
                  className="p-1.5 text-slate-400 hover:text-red-400 rounded"
                  title="Delete"
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}

        {secrets.length === 0 && (
          <EmptyState
            message="No secrets configured"
            action={{ label: 'Add First Secret', onClick: () => setShowCreate(true) }}
          />
        )}
        {secrets.length > 0 && (
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={totalItems}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        )}
      </div>
    </div>
  );
}

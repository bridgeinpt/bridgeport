import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store.js';
import {
  listSecrets,
  createSecret,
  getSecretValue,
  updateSecret,
  deleteSecret,
  listVars,
  createVar,
  updateVar,
  deleteVar,
  getModuleSettings,
  type Secret,
  type Var,
} from '../lib/api.js';
import { formatDistanceToNow } from 'date-fns';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { LockIcon, WarningIcon, PencilIcon, TrashIcon, EyeIcon, LinkIcon } from '../components/Icons.js';
import Pagination from '../components/Pagination.js';
import { usePagination } from '../hooks/usePagination.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { EmptyState } from '../components/EmptyState.js';
import { ScanSuggestionsPanel } from '../components/ScanSuggestionsPanel.js';

type ActiveTab = 'secrets' | 'vars';

export default function Secrets() {
  const { selectedEnvironment } = useAppStore();
  const [activeTab, setActiveTab] = useState<ActiveTab>('secrets');
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [vars, setVars] = useState<Var[]>([]);
  const [loading, setLoading] = useState(true);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newNeverReveal, setNewNeverReveal] = useState(false);
  const [creating, setCreating] = useState(false);

  // Secret reveal
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({});
  const [allowSecretReveal, setAllowSecretReveal] = useState(true);

  // Edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // Delete
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; key: string; type: ActiveTab } | null>(null);

  // Usage expansion
  const [expandedUsage, setExpandedUsage] = useState<Record<string, boolean>>({});

  const loadData = () => {
    if (!selectedEnvironment?.id) return;
    setLoading(true);
    Promise.all([
      listSecrets(selectedEnvironment.id),
      listVars(selectedEnvironment.id),
      getModuleSettings(selectedEnvironment.id, 'configuration'),
    ])
      .then(([secretsRes, varsRes, settingsRes]) => {
        setSecrets(secretsRes.secrets);
        setVars(varsRes.vars);
        setAllowSecretReveal(settingsRes.settings.allowSecretReveal as boolean);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, [selectedEnvironment?.id]);

  // Create handlers
  const handleCreateSecret = async (e: React.FormEvent) => {
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
      closeCreate();
    } finally {
      setCreating(false);
    }
  };

  const handleCreateVar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;
    setCreating(true);
    try {
      const res = await createVar(selectedEnvironment.id, {
        key: newKey,
        value: newValue,
        description: newDescription || undefined,
      });
      setVars((prev) => [...prev, res.var]);
      closeCreate();
    } finally {
      setCreating(false);
    }
  };

  const closeCreate = () => {
    setShowCreate(false);
    setNewKey('');
    setNewValue('');
    setNewDescription('');
    setNewNeverReveal(false);
  };

  // Reveal
  const handleReveal = async (secret: Secret) => {
    if (revealedSecrets[secret.id]) {
      setRevealedSecrets((prev) => { const n = { ...prev }; delete n[secret.id]; return n; });
      setRevealErrors((prev) => { const n = { ...prev }; delete n[secret.id]; return n; });
      return;
    }
    try {
      const { value } = await getSecretValue(secret.id);
      setRevealedSecrets((prev) => ({ ...prev, [secret.id]: value }));
      setRevealErrors((prev) => { const n = { ...prev }; delete n[secret.id]; return n; });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reveal secret';
      setRevealErrors((prev) => ({ ...prev, [secret.id]: message }));
    }
  };

  // Edit
  const handleEditSecret = async (id: string) => {
    if (!editValue) return;
    await updateSecret(id, { value: editValue });
    setEditingId(null);
    setEditValue('');
    setRevealedSecrets((prev) => { const n = { ...prev }; delete n[id]; return n; });
  };

  const handleEditVar = async (id: string) => {
    if (!editValue) return;
    const res = await updateVar(id, { value: editValue });
    setVars((prev) => prev.map((v) => (v.id === id ? res.var : v)));
    setEditingId(null);
    setEditValue('');
  };

  // Delete
  const handleDelete = async () => {
    if (!deleteConfirm) return;
    if (deleteConfirm.type === 'secrets') {
      await deleteSecret(deleteConfirm.id);
      setSecrets((prev) => prev.filter((s) => s.id !== deleteConfirm.id));
    } else {
      await deleteVar(deleteConfirm.id);
      setVars((prev) => prev.filter((v) => v.id !== deleteConfirm.id));
    }
    setDeleteConfirm(null);
  };

  const canReveal = (secret: Secret) => allowSecretReveal && !secret.neverReveal;
  const toggleUsage = (id: string) => setExpandedUsage((prev) => ({ ...prev, [id]: !prev[id] }));

  // Pagination for active tab
  const secretsPagination = usePagination({ data: secrets, defaultPageSize: 25 });
  const varsPagination = usePagination({ data: vars, defaultPageSize: 25 });

  // Unused items warning
  const unusedSecrets = secrets.filter((s) => (s.usageCount ?? 0) === 0);
  const unusedVars = vars.filter((v) => (v.usageCount ?? 0) === 0);
  const unusedCount = activeTab === 'secrets' ? unusedSecrets.length : unusedVars.length;

  if (loading) {
    return <LoadingSkeleton rows={5} rowHeight="h-11" />;
  }

  return (
    <div className="p-6">
      {/* Tabs + Add Button */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1 bg-slate-800/50 rounded-lg p-0.5">
          <button
            onClick={() => setActiveTab('secrets')}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'secrets'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Secrets
            {secrets.length > 0 && (
              <span className="ml-1.5 text-xs text-slate-500">{secrets.length}</span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('vars')}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'vars'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Vars
            {vars.length > 0 && (
              <span className="ml-1.5 text-xs text-slate-500">{vars.length}</span>
            )}
          </button>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn btn-primary">
          Add {activeTab === 'secrets' ? 'Secret' : 'Var'}
        </button>
      </div>

      {/* Scan Suggestions Panel */}
      {selectedEnvironment?.id && (
        <ScanSuggestionsPanel environmentId={selectedEnvironment.id} onApplied={loadData} />
      )}

      {/* Unused warning (compact) */}
      {unusedCount > 0 && (
        <div className="mb-3 flex items-center gap-2 text-sm text-yellow-400/80 px-1">
          <WarningIcon className="w-3.5 h-3.5" />
          {unusedCount} {activeTab === 'secrets' ? 'secret' : 'var'}{unusedCount > 1 ? 's are' : ' is'} unreferenced — may be candidates for cleanup.
        </div>
      )}

      {/* Create Modal */}
      <Modal
        isOpen={showCreate}
        onClose={closeCreate}
        title={activeTab === 'secrets' ? 'Add Secret' : 'Add Var'}
        size="md"
      >
        <form onSubmit={activeTab === 'secrets' ? handleCreateSecret : handleCreateVar} className="space-y-4">
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
            <p className="text-xs text-slate-500 mt-1">Uppercase with underscores (e.g., API_KEY)</p>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Value</label>
            <textarea
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={activeTab === 'secrets' ? 'Secret value...' : 'Variable value...'}
              rows={3}
              className="input"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Description (optional)</label>
            <input
              type="text"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder={`What is this ${activeTab === 'secrets' ? 'secret' : 'variable'} for?`}
              className="input"
            />
          </div>
          {activeTab === 'secrets' && (
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
          )}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={closeCreate} className="btn btn-ghost">Cancel</button>
            <button type="submit" disabled={creating} className="btn btn-primary">
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
        title={`Delete ${deleteConfirm?.type === 'secrets' ? 'Secret' : 'Var'}`}
        message={`Are you sure you want to delete "${deleteConfirm?.key}"? This action cannot be undone.`}
        confirmText="Delete"
        variant="danger"
      />

      {/* Table */}
      {activeTab === 'secrets' ? (
        secrets.length === 0 ? (
          <EmptyState
            message="No secrets configured"
            action={{ label: 'Add First Secret', onClick: () => setShowCreate(true) }}
          />
        ) : (
          <>
            <div className="border border-slate-700 rounded-lg overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-800/50 text-left text-xs text-slate-400 uppercase tracking-wider">
                    <th className="px-4 py-2.5">Key</th>
                    <th className="px-4 py-2.5">Value</th>
                    <th className="px-4 py-2.5">References</th>
                    <th className="px-4 py-2.5">Updated</th>
                    <th className="px-4 py-2.5 w-24"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {secretsPagination.paginatedData.map((secret) => (
                    <SecretRow
                      key={secret.id}
                      secret={secret}
                      canReveal={canReveal(secret)}
                      revealedValue={revealedSecrets[secret.id]}
                      revealError={revealErrors[secret.id]}
                      isEditing={editingId === secret.id}
                      editValue={editValue}
                      expandedUsage={!!expandedUsage[secret.id]}
                      onReveal={() => handleReveal(secret)}
                      onEdit={() => { setEditingId(secret.id); setEditValue(''); }}
                      onEditValueChange={setEditValue}
                      onEditSave={() => handleEditSecret(secret.id)}
                      onEditCancel={() => { setEditingId(null); setEditValue(''); }}
                      onDelete={() => setDeleteConfirm({ id: secret.id, key: secret.key, type: 'secrets' })}
                      onToggleUsage={() => toggleUsage(secret.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3">
              <Pagination
                currentPage={secretsPagination.currentPage}
                totalPages={secretsPagination.totalPages}
                totalItems={secretsPagination.totalItems}
                pageSize={secretsPagination.pageSize}
                onPageChange={secretsPagination.setPage}
                onPageSizeChange={secretsPagination.setPageSize}
              />
            </div>
          </>
        )
      ) : vars.length === 0 ? (
        <EmptyState
          message="No variables configured"
          action={{ label: 'Add First Var', onClick: () => setShowCreate(true) }}
        />
      ) : (
        <>
          <div className="border border-slate-700 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-800/50 text-left text-xs text-slate-400 uppercase tracking-wider">
                  <th className="px-4 py-2.5">Key</th>
                  <th className="px-4 py-2.5">Value</th>
                  <th className="px-4 py-2.5">References</th>
                  <th className="px-4 py-2.5">Updated</th>
                  <th className="px-4 py-2.5 w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {varsPagination.paginatedData.map((v) => (
                  <VarRow
                    key={v.id}
                    v={v}
                    isEditing={editingId === v.id}
                    editValue={editValue}
                    expandedUsage={!!expandedUsage[v.id]}
                    onEdit={() => { setEditingId(v.id); setEditValue(v.value); }}
                    onEditValueChange={setEditValue}
                    onEditSave={() => handleEditVar(v.id)}
                    onEditCancel={() => { setEditingId(null); setEditValue(''); }}
                    onDelete={() => setDeleteConfirm({ id: v.id, key: v.key, type: 'vars' })}
                    onToggleUsage={() => toggleUsage(v.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <Pagination
              currentPage={varsPagination.currentPage}
              totalPages={varsPagination.totalPages}
              totalItems={varsPagination.totalItems}
              pageSize={varsPagination.pageSize}
              onPageChange={varsPagination.setPage}
              onPageSizeChange={varsPagination.setPageSize}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secret Row
// ---------------------------------------------------------------------------

interface SecretRowProps {
  secret: Secret;
  canReveal: boolean;
  revealedValue?: string;
  revealError?: string;
  isEditing: boolean;
  editValue: string;
  expandedUsage: boolean;
  onReveal: () => void;
  onEdit: () => void;
  onEditValueChange: (v: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onDelete: () => void;
  onToggleUsage: () => void;
}

function SecretRow({
  secret, canReveal, revealedValue, revealError,
  isEditing, editValue, expandedUsage,
  onReveal, onEdit, onEditValueChange, onEditSave, onEditCancel, onDelete, onToggleUsage,
}: SecretRowProps) {
  const usageCount = secret.usageCount ?? 0;

  return (
    <>
      <tr className={`hover:bg-slate-800/30 ${usageCount === 0 ? 'border-l-2 border-l-yellow-500/50' : ''}`}>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="font-mono font-medium text-white text-sm">{secret.key}</span>
            {secret.neverReveal && (
              <span title="Write-only"><LockIcon className="w-3 h-3 text-amber-400" /></span>
            )}
          </div>
          {secret.description && (
            <p className="text-xs text-slate-500 mt-0.5">{secret.description}</p>
          )}
        </td>
        <td className="px-4 py-2.5">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editValue}
                onChange={(e) => onEditValueChange(e.target.value)}
                className="input text-sm font-mono w-48"
                placeholder="New value..."
                autoFocus
              />
              <button onClick={onEditSave} className="btn btn-primary text-xs py-1 px-2">Save</button>
              <button onClick={onEditCancel} className="btn btn-ghost text-xs py-1 px-2">Cancel</button>
            </div>
          ) : revealError ? (
            <span className="text-sm text-red-400">{revealError}</span>
          ) : revealedValue ? (
            <code className="text-sm font-mono text-green-400 bg-slate-950 px-1.5 py-0.5 rounded break-all">
              {revealedValue}
            </code>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-slate-500 font-mono text-sm">{'••••••••'}</span>
              {canReveal && (
                <button
                  onClick={onReveal}
                  className="text-slate-500 hover:text-slate-300"
                  title="Reveal"
                >
                  <EyeIcon className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
          {revealedValue && (
            <button onClick={onReveal} className="text-xs text-slate-500 hover:text-slate-300 mt-0.5">
              Hide
            </button>
          )}
        </td>
        <td className="px-4 py-2.5">
          {usageCount > 0 ? (
            <button
              onClick={onToggleUsage}
              className="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-1"
            >
              <LinkIcon className="w-3 h-3" />
              {usageCount}
            </button>
          ) : (
            <span className="text-xs text-yellow-400/60">—</span>
          )}
        </td>
        <td className="px-4 py-2.5 text-xs text-slate-500">
          {formatDistanceToNow(new Date(secret.updatedAt), { addSuffix: true })}
        </td>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-0.5">
            <button onClick={onEdit} className="p-1 text-slate-400 hover:text-white rounded" title="Edit">
              <PencilIcon className="w-3.5 h-3.5" />
            </button>
            <button onClick={onDelete} className="p-1 text-slate-400 hover:text-red-400 rounded" title="Delete">
              <TrashIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </td>
      </tr>
      {/* Expanded usage row */}
      {expandedUsage && secret.usedByServices && secret.usedByServices.length > 0 && (
        <tr>
          <td colSpan={5} className="px-8 py-2 bg-slate-800/20">
            <div className="space-y-1 text-sm">
              {secret.usedByServices.map((svc) => (
                <Link key={svc.id} to={`/services/${svc.id}`} className="block text-slate-300 hover:text-white">
                  <span className="text-slate-500">{svc.serverName} /</span> {svc.name}
                </Link>
              ))}
              {secret.usedByConfigFiles && secret.usedByConfigFiles.length > 0 && (
                <p className="text-xs text-slate-500">
                  Referenced in: {secret.usedByConfigFiles.map((f) => f.name).join(', ')}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Var Row
// ---------------------------------------------------------------------------

interface VarRowProps {
  v: Var;
  isEditing: boolean;
  editValue: string;
  expandedUsage: boolean;
  onEdit: () => void;
  onEditValueChange: (v: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onDelete: () => void;
  onToggleUsage: () => void;
}

function VarRow({ v, isEditing, editValue, expandedUsage, onEdit, onEditValueChange, onEditSave, onEditCancel, onDelete, onToggleUsage }: VarRowProps) {
  const usageCount = v.usageCount ?? 0;

  return (
    <>
      <tr className={`hover:bg-slate-800/30 ${usageCount === 0 ? 'border-l-2 border-l-yellow-500/50' : ''}`}>
        <td className="px-4 py-2.5">
          <span className="font-mono font-medium text-white text-sm">{v.key}</span>
          {v.description && (
            <p className="text-xs text-slate-500 mt-0.5">{v.description}</p>
          )}
        </td>
        <td className="px-4 py-2.5">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editValue}
                onChange={(e) => onEditValueChange(e.target.value)}
                className="input text-sm font-mono w-48"
                autoFocus
              />
              <button onClick={onEditSave} className="btn btn-primary text-xs py-1 px-2">Save</button>
              <button onClick={onEditCancel} className="btn btn-ghost text-xs py-1 px-2">Cancel</button>
            </div>
          ) : (
            <span className="text-sm font-mono text-slate-300 truncate block max-w-xs" title={v.value}>
              {v.value.length > 60 ? v.value.slice(0, 60) + '...' : v.value}
            </span>
          )}
        </td>
        <td className="px-4 py-2.5">
          {usageCount > 0 ? (
            <button
              onClick={onToggleUsage}
              className="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-1"
            >
              <LinkIcon className="w-3 h-3" />
              {usageCount}
            </button>
          ) : (
            <span className="text-xs text-yellow-400/60">—</span>
          )}
        </td>
        <td className="px-4 py-2.5 text-xs text-slate-500">
          {formatDistanceToNow(new Date(v.updatedAt), { addSuffix: true })}
        </td>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-0.5">
            <button onClick={onEdit} className="p-1 text-slate-400 hover:text-white rounded" title="Edit">
              <PencilIcon className="w-3.5 h-3.5" />
            </button>
            <button onClick={onDelete} className="p-1 text-slate-400 hover:text-red-400 rounded" title="Delete">
              <TrashIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </td>
      </tr>
      {expandedUsage && v.usedByServices && v.usedByServices.length > 0 && (
        <tr>
          <td colSpan={5} className="px-8 py-2 bg-slate-800/20">
            <div className="space-y-1 text-sm">
              {v.usedByServices.map((svc) => (
                <Link key={svc.id} to={`/services/${svc.id}`} className="block text-slate-300 hover:text-white">
                  <span className="text-slate-500">{svc.serverName} /</span> {svc.name}
                </Link>
              ))}
              {v.usedByConfigFiles && v.usedByConfigFiles.length > 0 && (
                <p className="text-xs text-slate-500">
                  Referenced in: {v.usedByConfigFiles.map((f) => f.name).join(', ')}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

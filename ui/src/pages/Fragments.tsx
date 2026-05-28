import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store.js';
import {
  listConfigFragments,
  createConfigFragment,
  updateConfigFragment,
  deleteConfigFragment,
  ApiRequestError,
  type ConfigFragment,
} from '../lib/api.js';
import { formatDistanceToNow } from 'date-fns';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { EmptyState } from '../components/EmptyState.js';
import { PencilIcon, TrashIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';

/**
 * Env-scoped ConfigFragments: named, reusable text blocks that ConfigFiles can
 * include. Operators maintain ~50-line `.env` ConfigFiles where most lines are
 * identical across services; fragments let the shared portion live in one
 * place and get concatenated into each ConfigFile at deploy / sync time.
 */
export default function Fragments() {
  const toast = useToast();
  const { selectedEnvironment } = useAppStore();
  const [fragments, setFragments] = useState<ConfigFragment[]>([]);
  const [loading, setLoading] = useState(true);

  // Create / edit modal state
  const [editing, setEditing] = useState<ConfigFragment | null>(null);
  const [creating, setCreating] = useState(false);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formContent, setFormContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<ConfigFragment | null>(null);
  const [deleteBlockedBy, setDeleteBlockedBy] = useState<
    Array<{ configFileId: string; configFileName: string; serviceId: string | null; serviceName: string | null }>
    | null
  >(null);

  const loadData = () => {
    if (!selectedEnvironment?.id) return;
    setLoading(true);
    listConfigFragments(selectedEnvironment.id)
      .then((res) => setFragments(res.fragments))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEnvironment?.id]);

  const openCreate = () => {
    setCreating(true);
    setEditing(null);
    setFormName('');
    setFormDescription('');
    setFormContent('');
  };

  const openEdit = (fragment: ConfigFragment) => {
    setEditing(fragment);
    setCreating(false);
    setFormName(fragment.name);
    setFormDescription(fragment.description ?? '');
    setFormContent(fragment.content);
  };

  const closeForm = () => {
    setCreating(false);
    setEditing(null);
    setFormName('');
    setFormDescription('');
    setFormContent('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvironment?.id) return;
    setSaving(true);
    try {
      if (editing) {
        await updateConfigFragment(editing.id, {
          name: formName,
          description: formDescription || undefined,
          content: formContent,
        });
        toast.success('Fragment updated');
      } else {
        await createConfigFragment(selectedEnvironment.id, {
          name: formName,
          description: formDescription || undefined,
          content: formContent,
        });
        toast.success('Fragment created');
      }
      closeForm();
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteConfigFragment(deleteTarget.id);
      toast.success('Fragment deleted');
      setDeleteTarget(null);
      setDeleteBlockedBy(null);
      loadData();
    } catch (err) {
      // 409: surface the inUseBy list so operators can see which ConfigFiles
      // (and their attached services) still reference this fragment. The
      // server returns `{code: 'CONFLICT', details: {inUseBy: [...]}}` —
      // ApiRequestError carries the structured body verbatim.
      if (err instanceof ApiRequestError && err.status === 409) {
        const details = err.details as
          | { inUseBy?: Array<{ configFileId: string; configFileName: string; serviceId: string | null; serviceName: string | null }> }
          | undefined;
        if (details?.inUseBy && details.inUseBy.length > 0) {
          setDeleteBlockedBy(details.inUseBy);
          // Keep the dialog open so the operator can read the list.
          return;
        }
      }
      const message = err instanceof Error ? err.message : 'Delete failed';
      toast.error(message);
    }
  };

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
    return <LoadingSkeleton rows={5} rowHeight="h-11" />;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-4">
        <button onClick={openCreate} className="btn btn-primary">
          New Fragment
        </button>
      </div>

      <p className="text-sm text-slate-400 mb-4">
        Fragments are reusable text blocks that ConfigFiles can include. The fragment
        content is concatenated before the ConfigFile&apos;s own content at deploy/sync
        time. Use them to share common <code>{'${KEY}'}</code> blocks across services
        — last-definition-wins on duplicate keys, so service-specific overrides still
        work.
      </p>

      {fragments.length === 0 ? (
        <EmptyState
          message="No fragments configured"
          action={{ label: 'Create First Fragment', onClick: openCreate }}
        />
      ) : (
        <div className="border border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-800/50 text-left text-xs text-slate-400 uppercase tracking-wider">
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Description</th>
                <th className="px-4 py-2.5">Used by</th>
                <th className="px-4 py-2.5">Updated</th>
                <th className="px-4 py-2.5 w-24"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {fragments.map((fragment) => (
                <tr key={fragment.id} className="hover:bg-slate-800/30">
                  <td className="px-4 py-2.5">
                    <span className="font-mono font-medium text-white text-sm">
                      {fragment.name}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-slate-400">
                    {fragment.description || <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-slate-400">
                    {fragment.usedByCount ?? 0}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-slate-400">
                    {formatDistanceToNow(new Date(fragment.updatedAt), { addSuffix: true })}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() => openEdit(fragment)}
                        className="p-1.5 text-slate-500 hover:text-slate-200"
                        title="Edit"
                      >
                        <PencilIcon className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(fragment)}
                        className="p-1.5 text-slate-500 hover:text-red-400"
                        title="Delete"
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / Edit Modal */}
      <Modal
        isOpen={creating || !!editing}
        onClose={closeForm}
        title={editing ? `Edit fragment: ${editing.name}` : 'New Fragment'}
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Name</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="common-backend"
              className="input"
              required
            />
            <p className="text-xs text-slate-500 mt-1">Must be unique within this environment.</p>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Description (optional)</label>
            <input
              type="text"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="Common DB + Redis config shared across backend services"
              className="input"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Content</label>
            <textarea
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              rows={14}
              className="input font-mono text-sm"
              placeholder={'DB_URL=${DB_URL}\nREDIS_URL=${REDIS_URL}'}
            />
            <p className="text-xs text-slate-500 mt-1">
              <code>{'${KEY}'}</code> placeholders are resolved against this
              environment&apos;s secrets and vars when the including ConfigFile is
              deployed or synced.
            </p>
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={closeForm} className="btn btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => {
          setDeleteTarget(null);
          setDeleteBlockedBy(null);
        }}
        onConfirm={handleDelete}
        title="Delete fragment"
        message={
          deleteBlockedBy && deleteBlockedBy.length > 0
            ? `This fragment is in use and cannot be deleted. It is referenced by: ${deleteBlockedBy
                .map((r) =>
                  r.serviceName
                    ? `${r.configFileName} (service: ${r.serviceName})`
                    : `${r.configFileName} (unattached)`
                )
                .join(', ')}.`
            : `Delete fragment "${deleteTarget?.name}"? This cannot be undone.`
        }
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
}

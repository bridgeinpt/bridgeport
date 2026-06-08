import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../lib/store.js';
import {
  listConfigFragments,
  getConfigFragment,
  createConfigFragment,
  updateConfigFragment,
  deleteConfigFragment,
  ApiRequestError,
  type ConfigFragment,
  type ConfigFragmentUsage,
} from '../lib/api.js';
import { formatDistanceToNow } from 'date-fns';
import { Modal } from '../components/Modal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { EmptyState } from '../components/EmptyState.js';
import { PencilIcon, TrashIcon, EyeIcon, LinkIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';
import { getErrorMessage } from '../lib/helpers.js';

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

  // Read-only view modal state
  const [viewing, setViewing] = useState<ConfigFragment | null>(null);

  // "Used by" expandable usage: lazily fetch the detail endpoint on expand and
  // cache the result by fragment id so re-expanding the same row never refetches.
  const [expandedUsage, setExpandedUsage] = useState<Record<string, boolean>>({});
  const [usageById, setUsageById] = useState<Record<string, ConfigFragmentUsage[]>>({});
  const [usageLoading, setUsageLoading] = useState<Record<string, boolean>>({});

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

  const ensureUsage = (id: string) => {
    if (usageById[id] || usageLoading[id]) return;
    setUsageLoading((prev) => ({ ...prev, [id]: true }));
    getConfigFragment(id)
      .then((res) => setUsageById((prev) => ({ ...prev, [id]: res.fragment.usedBy })))
      .catch((err) => toast.error(getErrorMessage(err, 'Failed to load usage')))
      .finally(() => setUsageLoading((prev) => ({ ...prev, [id]: false })));
  };

  const toggleUsage = (id: string) => {
    const willExpand = !expandedUsage[id];
    setExpandedUsage((prev) => ({ ...prev, [id]: willExpand }));
    if (willExpand) ensureUsage(id);
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
      toast.error(getErrorMessage(err, 'Save failed'));
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
      toast.error(getErrorMessage(err, 'Delete failed'));
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
              {fragments.map((fragment) => {
                const usageCount = fragment.usedByCount ?? 0;
                return (
                <Fragment key={fragment.id}>
                <tr className="hover:bg-slate-800/30">
                  <td className="px-4 py-2.5">
                    <span className="font-mono font-medium text-white text-sm">
                      {fragment.name}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-slate-400">
                    {fragment.description || <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-slate-400">
                    {usageCount > 0 ? (
                      <button
                        onClick={() => toggleUsage(fragment.id)}
                        className="text-sm text-primary-400 hover:text-primary-300 flex items-center gap-1"
                      >
                        <LinkIcon className="w-3 h-3" />
                        {usageCount}
                      </button>
                    ) : (
                      <span className="text-xs text-yellow-400/60">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-slate-400">
                    {formatDistanceToNow(new Date(fragment.updatedAt), { addSuffix: true })}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() => {
                          setViewing(fragment);
                          ensureUsage(fragment.id);
                        }}
                        className="p-1.5 text-slate-500 hover:text-slate-200"
                        title="View"
                      >
                        <EyeIcon className="w-3.5 h-3.5" />
                      </button>
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
                {/* Expanded usage row: config files that include this fragment */}
                {expandedUsage[fragment.id] && (
                  <tr>
                    <td colSpan={5} className="px-8 py-2 bg-slate-800/20">
                      {usageLoading[fragment.id] ? (
                        <p className="text-xs text-slate-500">Loading usage…</p>
                      ) : usageById[fragment.id] && usageById[fragment.id].length > 0 ? (
                        <div className="space-y-2 text-sm">
                          {usageById[fragment.id].map((u) => (
                            <div key={u.configFileId}>
                              <Link
                                to="/config-files"
                                className="text-slate-300 hover:text-white"
                              >
                                {u.configFileName}{' '}
                                <span className="text-slate-500">({u.configFileFilename})</span>
                              </Link>
                              {u.services.length > 0 && (
                                <span className="text-xs text-slate-500">
                                  {' — '}
                                  {u.services.map((svc, i) => (
                                    <span key={svc.serviceId}>
                                      {i > 0 && ', '}
                                      <Link
                                        to={`/services/${svc.serviceId}`}
                                        className="text-primary-400 hover:text-primary-300"
                                      >
                                        {svc.serviceName}
                                      </Link>
                                    </span>
                                  ))}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-slate-500">Not used by any config files.</p>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
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

      {/* Read-only View Modal */}
      <Modal
        isOpen={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing ? `Fragment: ${viewing.name}` : ''}
        size="lg"
      >
        {viewing && (
          <div className="space-y-4">
            {viewing.description && (
              <p className="text-sm text-slate-400">{viewing.description}</p>
            )}
            <div>
              <label className="block text-sm text-slate-400 mb-1">Content</label>
              <pre className="bg-slate-950 rounded p-3 text-sm text-slate-200 font-mono whitespace-pre-wrap max-h-96 overflow-auto">
                {viewing.content}
              </pre>
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Used by</label>
              {usageLoading[viewing.id] && !usageById[viewing.id] ? (
                <p className="text-xs text-slate-500">Loading usage…</p>
              ) : usageById[viewing.id] && usageById[viewing.id].length > 0 ? (
                <div className="space-y-2 text-sm">
                  {usageById[viewing.id].map((u) => (
                    <div key={u.configFileId}>
                      <Link to="/config-files" className="text-slate-300 hover:text-white">
                        {u.configFileName}{' '}
                        <span className="text-slate-500">({u.configFileFilename})</span>
                      </Link>
                      {u.services.length > 0 && (
                        <span className="text-xs text-slate-500">
                          {' — '}
                          {u.services.map((svc, i) => (
                            <span key={svc.serviceId}>
                              {i > 0 && ', '}
                              <Link
                                to={`/services/${svc.serviceId}`}
                                className="text-primary-400 hover:text-primary-300"
                              >
                                {svc.serviceName}
                              </Link>
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500">Not used by any config files.</p>
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  openEdit(viewing);
                  setViewing(null);
                }}
                className="btn btn-secondary"
              >
                Edit
              </button>
              <button onClick={() => setViewing(null)} className="btn btn-ghost">
                Close
              </button>
            </div>
          </div>
        )}
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

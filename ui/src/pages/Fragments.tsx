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
import { Eye, Pencil, Trash2, Link2 } from 'lucide-react';
import { useToast } from '../components/Toast.js';
import { getErrorMessage } from '../lib/helpers.js';
import { ConfigFileEditor } from '../components/ConfigFileEditor.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/table-skeleton';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';

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

  // Shared rendering of the populated "Used by" list, used by both the expanded
  // table sub-row and the read-only view modal.
  const renderUsageList = (usage: ConfigFragmentUsage[]) => (
    <div className="space-y-2 text-sm">
      {usage.map((u) => (
        <div key={u.configFileId}>
          <Link to="/config-files" className="text-foreground hover:text-foreground/80">
            {u.configFileName}{' '}
            <span className="text-muted-foreground">({u.configFileFilename})</span>
          </Link>
          {u.services.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {' — '}
              {u.services.map((svc, i) => (
                <span key={svc.serviceId}>
                  {i > 0 && ', '}
                  <Link
                    to={`/services/${svc.serviceId}`}
                    className="text-primary hover:text-primary/80"
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
  );

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
        <div className="rounded-lg border bg-card text-center py-12">
          <p className="text-muted-foreground">Please select an environment</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6">
        <TableSkeleton rows={5} columns={5} />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-4">
        <Button onClick={openCreate}>New Fragment</Button>
      </div>

      <p className="text-sm text-muted-foreground mb-4">
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
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fragments.map((fragment) => {
                const usageCount = fragment.usedByCount ?? 0;
                return (
                <Fragment key={fragment.id}>
                <TableRow>
                  <TableCell>
                    <span className="font-mono font-medium text-foreground text-sm">
                      {fragment.name}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fragment.description || <span className="text-muted-foreground/60">—</span>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {usageCount > 0 ? (
                      <button
                        onClick={() => toggleUsage(fragment.id)}
                        className="text-sm text-primary hover:text-primary/80 flex items-center gap-1"
                      >
                        <Link2 className="w-3 h-3" />
                        {usageCount}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground/60">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDistanceToNow(new Date(fragment.updatedAt), { addSuffix: true })}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 justify-end">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          setViewing(fragment);
                          ensureUsage(fragment.id);
                        }}
                        title="View"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => openEdit(fragment)}
                        title="Edit"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDeleteTarget(fragment)}
                        className="hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                {/* Expanded usage row: config files that include this fragment */}
                {expandedUsage[fragment.id] && (
                  <TableRow>
                    <TableCell colSpan={5} className="px-8 py-2 bg-muted/30">
                      {usageLoading[fragment.id] ? (
                        <p className="text-xs text-muted-foreground">Loading usage…</p>
                      ) : usageById[fragment.id] && usageById[fragment.id].length > 0 ? (
                        renderUsageList(usageById[fragment.id])
                      ) : (
                        <p className="text-xs text-muted-foreground">Not used by any config files.</p>
                      )}
                    </TableCell>
                  </TableRow>
                )}
                </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create / Edit Modal */}
      <Dialog
        open={creating || !!editing}
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit fragment: ${editing.name}` : 'New Fragment'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="fragment-name">Name</Label>
              <Input
                id="fragment-name"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="common-backend"
                className="mt-1"
                required
              />
              <p className="text-xs text-muted-foreground mt-1">Must be unique within this environment.</p>
            </div>
            <div>
              <Label htmlFor="fragment-description">Description (optional)</Label>
              <Input
                id="fragment-description"
                type="text"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Common DB + Redis config shared across backend services"
                className="mt-1"
              />
            </div>
            <div>
              <Label className="mb-1 block">Content</Label>
              <ConfigFileEditor
                value={formContent}
                onChange={setFormContent}
                language="env"
                height="20rem"
              />
              <p className="text-xs text-muted-foreground mt-1">
                <code>{'${KEY}'}</code> placeholders are resolved against this
                environment&apos;s secrets and vars when the including ConfigFile is
                deployed or synced.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Read-only View Modal */}
      <Dialog
        open={!!viewing}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{viewing ? `Fragment: ${viewing.name}` : ''}</DialogTitle>
          </DialogHeader>
          {viewing && (
            <div className="space-y-4">
              {viewing.description && (
                <p className="text-sm text-muted-foreground">{viewing.description}</p>
              )}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label>Content</Label>
                  <CopyButton value={viewing.content} />
                </div>
                <pre className="bg-muted rounded p-3 text-sm text-foreground font-mono whitespace-pre-wrap max-h-96 overflow-auto">
                  {viewing.content}
                </pre>
              </div>
              <div>
                <Label className="mb-1 block">Used by</Label>
                {usageLoading[viewing.id] && !usageById[viewing.id] ? (
                  <p className="text-xs text-muted-foreground">Loading usage…</p>
                ) : usageById[viewing.id] && usageById[viewing.id].length > 0 ? (
                  renderUsageList(usageById[viewing.id])
                ) : (
                  <p className="text-xs text-muted-foreground">Not used by any config files.</p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="secondary"
                  onClick={() => {
                    openEdit(viewing);
                    setViewing(null);
                  }}
                >
                  Edit
                </Button>
                <Button variant="ghost" onClick={() => setViewing(null)}>
                  Close
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteBlockedBy(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete fragment</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteBlockedBy && deleteBlockedBy.length > 0
                ? `This fragment is in use and cannot be deleted. It is referenced by: ${deleteBlockedBy
                    .map((r) =>
                      r.serviceName
                        ? `${r.configFileName} (service: ${r.serviceName})`
                        : `${r.configFileName} (unattached)`
                    )
                    .join(', ')}.`
                : `Delete fragment "${deleteTarget?.name}"? This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setDeleteTarget(null);
                setDeleteBlockedBy(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={(e) => {
                // Keep the dialog open: handleDelete decides whether to close
                // (success) or surface the blocked-by list (409).
                e.preventDefault();
                handleDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

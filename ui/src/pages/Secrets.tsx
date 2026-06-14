import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore, useAuthStore, isAdmin } from '../lib/store.js';
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
import { Lock, TriangleAlert, Pencil, Trash2, Eye, Link2 } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/ui/empty-state';
import { DataPagination } from '@/components/ui/data-pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/ui/copy-button';
import { usePagination } from '../hooks/usePagination.js';
import { ScanSuggestionsPanel } from '../components/ScanSuggestionsPanel.js';

type ActiveTab = 'secrets' | 'vars';

export default function Secrets() {
  const { selectedEnvironment } = useAppStore();
  const { user } = useAuthStore();
  const confirm = useConfirm();
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
  const handleDelete = async (item: { id: string; key: string; type: ActiveTab }) => {
    const ok = await confirm({
      title: `Delete ${item.type === 'secrets' ? 'Secret' : 'Var'}`,
      description: `Are you sure you want to delete "${item.key}"? This action cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    if (item.type === 'secrets') {
      await deleteSecret(item.id);
      setSecrets((prev) => prev.filter((s) => s.id !== item.id));
    } else {
      await deleteVar(item.id);
      setVars((prev) => prev.filter((v) => v.id !== item.id));
    }
  };

  // Revealing a value is admin-only (the API enforces this too — see
  // GET /api/secrets/:id/value). The env toggle and write-only flag gate it further.
  const canReveal = (secret: Secret) => isAdmin(user) && allowSecretReveal && !secret.neverReveal;
  const toggleUsage = (id: string) => setExpandedUsage((prev) => ({ ...prev, [id]: !prev[id] }));

  // Pagination for active tab
  const secretsPagination = usePagination({ data: secrets, defaultPageSize: 25 });
  const varsPagination = usePagination({ data: vars, defaultPageSize: 25 });

  // Unused items warning
  const unusedSecrets = secrets.filter((s) => (s.usageCount ?? 0) === 0);
  const unusedVars = vars.filter((v) => (v.usageCount ?? 0) === 0);
  const unusedCount = activeTab === 'secrets' ? unusedSecrets.length : unusedVars.length;

  if (loading) {
    return (
      <div className="p-6 space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-11 w-full rounded" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Tabs + Add Button */}
      <div className="flex items-center justify-between mb-4">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ActiveTab)}>
          <TabsList>
            <TabsTrigger value="secrets">
              Secrets
              {secrets.length > 0 && (
                <span className="ml-1.5 text-xs text-muted-foreground">{secrets.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="vars">
              Vars
              {vars.length > 0 && (
                <span className="ml-1.5 text-xs text-muted-foreground">{vars.length}</span>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button onClick={() => setShowCreate(true)}>
          Add {activeTab === 'secrets' ? 'Secret' : 'Var'}
        </Button>
      </div>

      {/* Scan Suggestions Panel */}
      {selectedEnvironment?.id && (
        <ScanSuggestionsPanel environmentId={selectedEnvironment.id} onApplied={loadData} />
      )}

      {/* Unused warning (compact) */}
      {unusedCount > 0 && (
        <div className="mb-3 flex items-center gap-2 text-sm text-warning px-1">
          <TriangleAlert className="size-3.5" />
          {unusedCount} {activeTab === 'secrets' ? 'secret' : 'var'}{unusedCount > 1 ? 's are' : ' is'} unreferenced — may be candidates for cleanup.
        </div>
      )}

      {/* Create Modal */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => { if (!open) closeCreate(); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{activeTab === 'secrets' ? 'Add Secret' : 'Add Var'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={activeTab === 'secrets' ? handleCreateSecret : handleCreateVar} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-key">Key</Label>
              <Input
                id="new-key"
                type="text"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value.toUpperCase())}
                placeholder="DATABASE_URL"
                pattern="^[A-Z][A-Z0-9_]*$"
                required
              />
              <p className="text-xs text-muted-foreground">Uppercase with underscores (e.g., API_KEY)</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-value">Value</Label>
              <Textarea
                id="new-value"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder={activeTab === 'secrets' ? 'Secret value...' : 'Variable value...'}
                rows={3}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-description">Description (optional)</Label>
              <Input
                id="new-description"
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={`What is this ${activeTab === 'secrets' ? 'secret' : 'variable'} for?`}
              />
            </div>
            {activeTab === 'secrets' && (
              <Label className="flex items-center gap-2 text-sm font-normal">
                <Checkbox
                  id="neverReveal"
                  checked={newNeverReveal}
                  onCheckedChange={(checked) => setNewNeverReveal(checked === true)}
                />
                <span className="text-foreground">Write-only (cannot be revealed after creation)</span>
              </Label>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeCreate}>Cancel</Button>
              <Button type="submit" disabled={creating}>
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Table */}
      {activeTab === 'secrets' ? (
        secrets.length === 0 ? (
          <EmptyState
            message="No secrets configured"
            action={{ label: 'Add First Secret', onClick: () => setShowCreate(true) }}
          />
        ) : (
          <>
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="text-xs uppercase tracking-wider">
                    <TableHead>Key</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>References</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-24"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
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
                      onDelete={() => handleDelete({ id: secret.id, key: secret.key, type: 'secrets' })}
                      onToggleUsage={() => toggleUsage(secret.id)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mt-3">
              <DataPagination
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
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="text-xs uppercase tracking-wider">
                  <TableHead>Key</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>References</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
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
                    onDelete={() => handleDelete({ id: v.id, key: v.key, type: 'vars' })}
                    onToggleUsage={() => toggleUsage(v.id)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="mt-3">
            <DataPagination
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
      <TableRow className={usageCount === 0 ? 'border-l-2 border-l-warning/50' : undefined}>
        <TableCell>
          <div className="flex items-center gap-2">
            <span className="font-mono font-medium text-foreground text-sm">{secret.key}</span>
            {secret.neverReveal && (
              <span title="Write-only"><Lock className="size-3 text-warning" /></span>
            )}
          </div>
          {secret.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{secret.description}</p>
          )}
        </TableCell>
        <TableCell>
          {isEditing ? (
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={editValue}
                onChange={(e) => onEditValueChange(e.target.value)}
                className="text-sm font-mono w-48 h-8"
                placeholder="New value..."
                autoFocus
              />
              <Button onClick={onEditSave} size="sm">Save</Button>
              <Button onClick={onEditCancel} variant="ghost" size="sm">Cancel</Button>
            </div>
          ) : revealError ? (
            <span className="text-sm text-destructive">{revealError}</span>
          ) : revealedValue ? (
            <div className="flex items-center gap-1">
              <code className="text-sm font-mono text-success bg-muted px-1.5 py-0.5 rounded break-all">
                {revealedValue}
              </code>
              <CopyButton value={revealedValue} size="icon-sm" />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground font-mono text-sm">{'••••••••'}</span>
              {canReveal && (
                <button
                  onClick={onReveal}
                  className="text-muted-foreground hover:text-foreground"
                  title="Reveal"
                >
                  <Eye className="size-3.5" />
                </button>
              )}
            </div>
          )}
          {revealedValue && (
            <button onClick={onReveal} className="text-xs text-muted-foreground hover:text-foreground mt-0.5">
              Hide
            </button>
          )}
        </TableCell>
        <TableCell>
          {usageCount > 0 ? (
            <button
              onClick={onToggleUsage}
              className="text-sm text-primary hover:text-primary/80 flex items-center gap-1"
            >
              <Link2 className="size-3" />
              {usageCount}
            </button>
          ) : (
            <span className="text-xs text-warning/60">—</span>
          )}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(secret.updatedAt), { addSuffix: true })}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-0.5">
            <Button onClick={onEdit} variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" title="Edit">
              <Pencil className="size-3.5" />
            </Button>
            <Button onClick={onDelete} variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" title="Delete">
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {/* Expanded usage row */}
      {expandedUsage && secret.usedByServices && secret.usedByServices.length > 0 && (
        <TableRow>
          <TableCell colSpan={5} className="px-8 py-2 bg-muted/20">
            <div className="space-y-1 text-sm">
              {secret.usedByServices.map((svc) => (
                <Link key={svc.id} to={`/services/${svc.id}`} className="block text-foreground/80 hover:text-foreground">
                  <span className="text-muted-foreground">{svc.serverName} /</span> {svc.name}
                </Link>
              ))}
              {secret.usedByConfigFiles && secret.usedByConfigFiles.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Referenced in: {secret.usedByConfigFiles.map((f) => f.name).join(', ')}
                </p>
              )}
            </div>
          </TableCell>
        </TableRow>
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
      <TableRow className={usageCount === 0 ? 'border-l-2 border-l-warning/50' : undefined}>
        <TableCell>
          <span className="font-mono font-medium text-foreground text-sm">{v.key}</span>
          {v.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{v.description}</p>
          )}
        </TableCell>
        <TableCell>
          {isEditing ? (
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={editValue}
                onChange={(e) => onEditValueChange(e.target.value)}
                className="text-sm font-mono w-48 h-8"
                autoFocus
              />
              <Button onClick={onEditSave} size="sm">Save</Button>
              <Button onClick={onEditCancel} variant="ghost" size="sm">Cancel</Button>
            </div>
          ) : (
            <span className="text-sm font-mono text-foreground/80 truncate block max-w-xs" title={v.value}>
              {v.value.length > 60 ? v.value.slice(0, 60) + '...' : v.value}
            </span>
          )}
        </TableCell>
        <TableCell>
          {usageCount > 0 ? (
            <button
              onClick={onToggleUsage}
              className="text-sm text-primary hover:text-primary/80 flex items-center gap-1"
            >
              <Link2 className="size-3" />
              {usageCount}
            </button>
          ) : (
            <span className="text-xs text-warning/60">—</span>
          )}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(v.updatedAt), { addSuffix: true })}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-0.5">
            <Button onClick={onEdit} variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" title="Edit">
              <Pencil className="size-3.5" />
            </Button>
            <Button onClick={onDelete} variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" title="Delete">
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {expandedUsage && v.usedByServices && v.usedByServices.length > 0 && (
        <TableRow>
          <TableCell colSpan={5} className="px-8 py-2 bg-muted/20">
            <div className="space-y-1 text-sm">
              {v.usedByServices.map((svc) => (
                <Link key={svc.id} to={`/services/${svc.id}`} className="block text-foreground/80 hover:text-foreground">
                  <span className="text-muted-foreground">{svc.serverName} /</span> {svc.name}
                </Link>
              ))}
              {v.usedByConfigFiles && v.usedByConfigFiles.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Referenced in: {v.usedByConfigFiles.map((f) => f.name).join(', ')}
                </p>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

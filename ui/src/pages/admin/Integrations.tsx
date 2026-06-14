import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuthStore, isAdmin } from '../../lib/store';
import {
  listApiTokens,
  createApiToken,
  deleteApiToken,
  listServiceAccounts,
  createServiceAccount,
  updateServiceAccount,
  deleteServiceAccount,
  listUsers,
  listEnvironments,
  type ApiTokenRecord,
  type ServiceAccount,
  type User,
  type UserRole,
  type Environment,
} from '../../lib/api';
import { getErrorMessage } from '@/lib/helpers';
import { toast } from '@/components/Toast';
import { useConfirm } from '@/hooks/useConfirm';
import { Section } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { KeyRound, Pencil, Trash2, Users as UsersIcon } from 'lucide-react';

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
};

/** Role badge color, mapped onto the shared status variants. */
function roleVariant(role: UserRole): 'info' | 'warning' | 'neutral' {
  if (role === 'admin') return 'warning';
  if (role === 'operator') return 'info';
  return 'neutral';
}

function roleLessThanOrEqual(child: UserRole, parent: UserRole): boolean {
  const rank: Record<UserRole, number> = { admin: 3, operator: 2, viewer: 1 };
  return rank[child] <= rank[parent];
}

export default function Integrations() {
  const { user: currentUser } = useAuthStore();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);

  const [tokens, setTokens] = useState<ApiTokenRecord[]>([]);
  const [accounts, setAccounts] = useState<ServiceAccount[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);

  // Modals
  const [showCreateToken, setShowCreateToken] = useState(false);
  const [showCreateSa, setShowCreateSa] = useState(false);
  const [editingSa, setEditingSa] = useState<ServiceAccount | null>(null);
  const [newTokenValue, setNewTokenValue] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin(currentUser)) return;
    void loadAll();
  }, [currentUser]);

  async function loadAll() {
    setLoading(true);
    try {
      const [t, s, u, e] = await Promise.all([
        listApiTokens(),
        listServiceAccounts(),
        listUsers(),
        listEnvironments(),
      ]);
      setTokens(t.tokens);
      setAccounts(s.serviceAccounts);
      setUsers(u.users);
      setEnvironments(e.environments);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to load'));
    } finally {
      setLoading(false);
    }
  }

  async function handleRevokeToken(token: ApiTokenRecord) {
    const ok = await confirm({
      title: 'Revoke token?',
      description: `Revoke token "${token.name}"? Any tool using it will stop working immediately.`,
      confirmText: 'Revoke',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteApiToken(token.id);
      setTokens((prev) => prev.filter((t) => t.id !== token.id));
      toast.success('Token revoked');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to revoke token'));
    }
  }

  async function handleDeleteSa(sa: ServiceAccount) {
    const tokenCount = sa._count?.apiTokens ?? 0;
    const description = tokenCount
      ? `Delete service account "${sa.name}"? This will revoke ${tokenCount} token${tokenCount === 1 ? '' : 's'} immediately.`
      : `Delete service account "${sa.name}"?`;
    const ok = await confirm({
      title: 'Delete service account?',
      description,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteServiceAccount(sa.id);
      setAccounts((prev) => prev.filter((a) => a.id !== sa.id));
      // Tokens are cascaded server-side; reflect that in UI too.
      setTokens((prev) => prev.filter((t) => t.serviceAccountId !== sa.id));
      toast.success('Service account deleted');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to delete service account'));
    }
  }

  if (!isAdmin(currentUser)) {
    return (
      <div className="p-6">
        <Card className="py-12 text-center">
          <p className="text-destructive">Access denied. Admin privileges required.</p>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-32 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-8">
      <p className="text-sm text-muted-foreground">
        Manage credentials and connections for tools that talk to BRIDGEPORT.
      </p>

      <ApiTokensSection
        tokens={tokens}
        users={users}
        accounts={accounts}
        environments={environments}
        currentUserRole={currentUser?.role ?? 'viewer'}
        onCreate={() => setShowCreateToken(true)}
        onRevoke={handleRevokeToken}
      />

      <ServiceAccountsSection
        accounts={accounts}
        onCreate={() => setShowCreateSa(true)}
        onEdit={(sa) => setEditingSa(sa)}
        onDelete={handleDeleteSa}
      />

      <Section
        title="Webhooks"
        description="Outbound HTTP callbacks when events happen in BRIDGEPORT."
      >
        <p className="text-sm text-muted-foreground">
          Global notification webhooks are configured under{' '}
          <Link to="/admin/notifications" className="text-primary hover:underline">
            Notification Settings
          </Link>
          . Per-environment signed webhook subscriptions (with delivery history) are also available
          via the environment webhooks API.
        </p>
      </Section>

      <Section
        title="OAuth Apps"
        description="Let third-party tools sign users in via BRIDGEPORT."
      >
        <Badge variant="neutral">Coming soon</Badge>
      </Section>

      <CreateTokenModal
        open={showCreateToken}
        users={users}
        accounts={accounts}
        environments={environments}
        currentUserRole={currentUser?.role ?? 'viewer'}
        onClose={() => setShowCreateToken(false)}
        onCreated={(token, record) => {
          setNewTokenValue(token);
          // Refresh list so the new token shows with its scope details.
          void loadAll();
          setShowCreateToken(false);
          // record is unused beyond closing the modal but kept for future extension
          void record;
        }}
      />

      <TokenRevealModal token={newTokenValue} onClose={() => setNewTokenValue(null)} />

      <CreateServiceAccountModal
        open={showCreateSa}
        onClose={() => setShowCreateSa(false)}
        onCreated={(sa) => {
          setAccounts((prev) => [sa, ...prev]);
          setShowCreateSa(false);
        }}
      />

      <EditServiceAccountModal
        account={editingSa}
        onClose={() => setEditingSa(null)}
        onUpdated={(sa) => {
          setAccounts((prev) => prev.map((a) => (a.id === sa.id ? sa : a)));
          setEditingSa(null);
        }}
      />
    </div>
  );
}

// ============================================================
// API Tokens section
// ============================================================
function ApiTokensSection({
  tokens,
  users,
  accounts,
  environments,
  currentUserRole,
  onCreate,
  onRevoke,
}: {
  tokens: ApiTokenRecord[];
  users: User[];
  accounts: ServiceAccount[];
  environments: Environment[];
  currentUserRole: UserRole;
  onCreate: () => void;
  onRevoke: (t: ApiTokenRecord) => void;
}) {
  // Keep unused refs accessible for the modal via parent state; here we just render.
  void users;
  void accounts;
  void environments;
  void currentUserRole;

  return (
    <Section
      title="API Tokens"
      description="Bearer credentials for scripts, CI/CD, and other tools."
      actions={<Button onClick={onCreate}>New Token</Button>}
    >
      {tokens.length === 0 ? (
        <EmptyState icon={KeyRound} message="No API tokens yet." />
      ) : (
        <div className="space-y-2">
          {tokens.map((t) => (
            <TokenRow key={t.id} token={t} onRevoke={() => onRevoke(t)} />
          ))}
        </div>
      )}
    </Section>
  );
}

function TokenRow({ token, onRevoke }: { token: ApiTokenRecord; onRevoke: () => void }) {
  const expired = token.expiresAt ? new Date(token.expiresAt) < new Date() : false;
  const ownerLabel = token.user
    ? `${token.user.name || token.user.email}`
    : token.serviceAccount
      ? `${token.serviceAccount.name} (service account)`
      : 'Unknown';

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-foreground truncate">{token.name}</h3>
            <Badge variant={roleVariant(token.role)}>{ROLE_LABELS[token.role]}</Badge>
            {expired && <Badge variant="destructive">Expired</Badge>}
            {token.serviceAccount?.disabled && <Badge variant="warning">Owner disabled</Badge>}
          </div>
          <div className="text-xs text-muted-foreground mt-1 space-x-3">
            <span>Owner: {ownerLabel}</span>
            <span>
              Scope:{' '}
              {token.allEnvironments
                ? 'All environments'
                : token.environments.map((e) => e.environment.name).join(', ') || '—'}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-1 space-x-3">
            {token.tokenPrefix && <span className="font-mono">{token.tokenPrefix}…</span>}
            <span>Created {formatDistanceToNow(new Date(token.createdAt), { addSuffix: true })}</span>
            {token.lastUsedAt ? (
              <span>
                Last used {formatDistanceToNow(new Date(token.lastUsedAt), { addSuffix: true })}
              </span>
            ) : (
              <span>Never used</span>
            )}
            {token.expiresAt && (
              <span>
                {expired ? 'Expired' : 'Expires'}{' '}
                {formatDistanceToNow(new Date(token.expiresAt), { addSuffix: true })}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRevoke}
          title="Revoke"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </Card>
  );
}

// ============================================================
// Create Token Modal
// ============================================================
const createTokenSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  expiresInDays: z
    .number({ error: 'Enter a number of days' })
    .int()
    .min(1, 'At least 1 day')
    .max(365, 'Max 365 days'),
});
type CreateTokenValues = z.infer<typeof createTokenSchema>;

function CreateTokenModal({
  open,
  users,
  accounts,
  environments,
  currentUserRole,
  onClose,
  onCreated,
}: {
  open: boolean;
  users: User[];
  accounts: ServiceAccount[];
  environments: Environment[];
  currentUserRole: UserRole;
  onClose: () => void;
  onCreated: (token: string, record: unknown) => void;
}) {
  const [ownerKind, setOwnerKind] = useState<'user' | 'service-account'>('service-account');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [ownerSaId, setOwnerSaId] = useState('');
  const [role, setRole] = useState<UserRole>('viewer');
  const [scopeKind, setScopeKind] = useState<'all' | 'specific'>('all');
  const [envIds, setEnvIds] = useState<Set<string>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<CreateTokenValues>({
    resolver: zodResolver(createTokenSchema),
    defaultValues: { name: '', expiresInDays: 90 },
  });

  // Reset all state whenever the modal opens.
  useEffect(() => {
    if (open) {
      form.reset({ name: '', expiresInDays: 90 });
      setOwnerKind('service-account');
      setOwnerUserId('');
      setOwnerSaId('');
      setRole('viewer');
      setScopeKind('all');
      setEnvIds(new Set());
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Compute the role ceiling. The minted token's role can't exceed the owner's,
  // and the admin can't grant a role above their own (UI enforcement).
  const ownerRole: UserRole | null = useMemo(() => {
    if (ownerKind === 'user') {
      return (users.find((u) => u.id === ownerUserId)?.role ?? null) as UserRole | null;
    }
    return (accounts.find((a) => a.id === ownerSaId)?.role ?? null) as UserRole | null;
  }, [ownerKind, ownerUserId, ownerSaId, users, accounts]);

  const roleCeiling: UserRole =
    ownerRole && roleLessThanOrEqual(ownerRole, currentUserRole) ? ownerRole : currentUserRole;
  const availableRoles: UserRole[] = (['viewer', 'operator', 'admin'] as UserRole[]).filter((r) =>
    roleLessThanOrEqual(r, roleCeiling)
  );

  // If current role choice is no longer allowed, snap down.
  useEffect(() => {
    if (!availableRoles.includes(role)) {
      setRole(availableRoles[availableRoles.length - 1] ?? 'viewer');
    }
  }, [availableRoles, role]);

  async function onSubmit(values: CreateTokenValues) {
    setFormError(null);

    if (ownerKind === 'user' && !ownerUserId) {
      setFormError('Pick a user owner');
      return;
    }
    if (ownerKind === 'service-account' && !ownerSaId) {
      setFormError('Pick a service account owner');
      return;
    }
    if (scopeKind === 'specific' && envIds.size === 0) {
      setFormError('Select at least one environment, or switch to "All environments"');
      return;
    }

    try {
      const res = await createApiToken({
        name: values.name.trim(),
        ownerUserId: ownerKind === 'user' ? ownerUserId : undefined,
        ownerServiceAccountId: ownerKind === 'service-account' ? ownerSaId : undefined,
        role,
        allEnvironments: scopeKind === 'all',
        environmentIds: scopeKind === 'specific' ? Array.from(envIds) : undefined,
        expiresInDays: values.expiresInDays,
      });
      onCreated(res.token, res.tokenRecord);
    } catch (err) {
      setFormError(getErrorMessage(err, 'Failed to create token'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New API Token</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="ci-deploy-staging" maxLength={100} {...field} />
                  </FormControl>
                  <FormDescription>A label so you can identify this token later.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-2">
              <Label>Owner type</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={ownerKind === 'service-account' ? 'default' : 'outline'}
                  className="flex-1"
                  onClick={() => setOwnerKind('service-account')}
                >
                  Service account
                </Button>
                <Button
                  type="button"
                  variant={ownerKind === 'user' ? 'default' : 'outline'}
                  className="flex-1"
                  onClick={() => setOwnerKind('user')}
                >
                  User
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Service accounts survive admin turnover — recommended for tools and pipelines.
              </p>
            </div>

            {ownerKind === 'service-account' ? (
              <div className="space-y-2">
                <Label>Service account</Label>
                <Select value={ownerSaId} onValueChange={setOwnerSaId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose one…" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id} disabled={a.disabled}>
                        {a.name} ({ROLE_LABELS[a.role]})
                        {a.disabled ? ' — disabled' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>User</Label>
                <Select value={ownerUserId} onValueChange={setOwnerUserId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose one…" />
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name || u.email} ({ROLE_LABELS[u.role]})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label>Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as UserRole)}
                disabled={availableRoles.length === 0}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {availableRoles.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {ownerRole && (
                <p className="text-xs text-muted-foreground">
                  Capped at the owner's role ({ROLE_LABELS[ownerRole]}).
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Environment scope</Label>
              <RadioGroup
                value={scopeKind}
                onValueChange={(v) => setScopeKind(v as 'all' | 'specific')}
                className="gap-2"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="all" id="scope-all" />
                  <Label htmlFor="scope-all" className="font-normal cursor-pointer">
                    All environments
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="specific" id="scope-specific" />
                  <Label htmlFor="scope-specific" className="font-normal cursor-pointer">
                    Specific environments
                  </Label>
                </div>
              </RadioGroup>
              {scopeKind === 'specific' && (
                <div className="mt-2 border rounded p-2 max-h-40 overflow-y-auto space-y-1">
                  {environments.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-1">No environments exist yet.</p>
                  ) : (
                    environments.map((env) => (
                      <Label
                        key={env.id}
                        htmlFor={`env-${env.id}`}
                        className="flex items-center gap-2 font-normal px-1 py-1 hover:bg-accent rounded cursor-pointer"
                      >
                        <Checkbox
                          id={`env-${env.id}`}
                          checked={envIds.has(env.id)}
                          onCheckedChange={(checked) => {
                            const next = new Set(envIds);
                            if (checked) next.add(env.id);
                            else next.delete(env.id);
                            setEnvIds(next);
                          }}
                        />
                        {env.name}
                      </Label>
                    ))
                  )}
                </div>
              )}
            </div>

            <FormField
              control={form.control}
              name="expiresInDays"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Expires in (days)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      value={Number.isNaN(field.value) ? '' : field.value}
                      onChange={(e) => field.onChange(e.target.valueAsNumber)}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                    />
                  </FormControl>
                  <FormDescription>Max 365 days. Tokens cannot live forever.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Creating…' : 'Create Token'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function TokenRevealModal({ token, onClose }: { token: string | null; onClose: () => void }) {
  return (
    <Dialog open={token !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Token Created</DialogTitle>
          <DialogDescription className="text-warning">
            Copy this token now. It will not be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-2">
          <div className="flex-1 bg-muted border rounded p-3 font-mono text-xs text-foreground break-all">
            {token}
          </div>
          {token && <CopyButton value={token} />}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Service Accounts section
// ============================================================
function ServiceAccountsSection({
  accounts,
  onCreate,
  onEdit,
  onDelete,
}: {
  accounts: ServiceAccount[];
  onCreate: () => void;
  onEdit: (sa: ServiceAccount) => void;
  onDelete: (sa: ServiceAccount) => void;
}) {
  return (
    <Section
      title="Service Accounts"
      description="Machine identities for tools. Tokens minted against a service account survive owner turnover."
      actions={<Button onClick={onCreate}>New Service Account</Button>}
    >
      {accounts.length === 0 ? (
        <EmptyState icon={UsersIcon} message="No service accounts yet." />
      ) : (
        <div className="space-y-2">
          {accounts.map((sa) => (
            <Card key={sa.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-foreground font-mono truncate">{sa.name}</h3>
                    <Badge variant={roleVariant(sa.role)}>{ROLE_LABELS[sa.role]}</Badge>
                    {sa.disabled && <Badge variant="warning">Disabled</Badge>}
                  </div>
                  {sa.description && (
                    <p className="text-sm text-muted-foreground mt-1">{sa.description}</p>
                  )}
                  <div className="text-xs text-muted-foreground mt-1 space-x-3">
                    <span>
                      {sa._count?.apiTokens ?? 0} token
                      {(sa._count?.apiTokens ?? 0) === 1 ? '' : 's'}
                    </span>
                    <span>
                      Created {formatDistanceToNow(new Date(sa.createdAt), { addSuffix: true })}
                    </span>
                    {sa.createdBy && <span>by {sa.createdBy.name || sa.createdBy.email}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onEdit(sa)}
                    title="Edit"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onDelete(sa)}
                    title="Delete"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Section>
  );
}

const createSaSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(64)
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/,
      'Lowercase letters, digits, hyphens, underscores. Must start with a letter or digit.'
    ),
  description: z.string().max(500).optional(),
});
type CreateSaValues = z.infer<typeof createSaSchema>;

function CreateServiceAccountModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (sa: ServiceAccount) => void;
}) {
  const [role, setRole] = useState<UserRole>('viewer');
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<CreateSaValues>({
    resolver: zodResolver(createSaSchema),
    defaultValues: { name: '', description: '' },
  });

  useEffect(() => {
    if (open) {
      form.reset({ name: '', description: '' });
      setRole('viewer');
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onSubmit(values: CreateSaValues) {
    setFormError(null);
    try {
      const res = await createServiceAccount({
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
        role,
      });
      onCreated(res.serviceAccount);
    } catch (err) {
      setFormError(getErrorMessage(err, 'Failed to create service account'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Service Account</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="ci-deploy-staging" maxLength={64} {...field} />
                  </FormControl>
                  <FormDescription>
                    Lowercase letters, digits, hyphens, underscores. Must start with a letter or
                    digit.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="GitHub Actions deployer for staging"
                      rows={2}
                      maxLength={500}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer — Read-only</SelectItem>
                  <SelectItem value="operator">Operator — Deploy and manage services</SelectItem>
                  <SelectItem value="admin">Admin — Full access</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Tokens minted against this service account are capped at this role.
              </p>
            </div>
            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Creating…' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const editSaSchema = z.object({
  description: z.string().max(500).optional(),
});
type EditSaValues = z.infer<typeof editSaSchema>;

function EditServiceAccountModal({
  account,
  onClose,
  onUpdated,
}: {
  account: ServiceAccount | null;
  onClose: () => void;
  onUpdated: (sa: ServiceAccount) => void;
}) {
  const [role, setRole] = useState<UserRole>('viewer');
  const [disabled, setDisabled] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<EditSaValues>({
    resolver: zodResolver(editSaSchema),
    defaultValues: { description: '' },
  });

  useEffect(() => {
    if (account) {
      form.reset({ description: account.description ?? '' });
      setRole(account.role);
      setDisabled(account.disabled);
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  async function onSubmit(values: EditSaValues) {
    if (!account) return;
    setFormError(null);
    try {
      const res = await updateServiceAccount(account.id, {
        description: values.description?.trim() || undefined,
        role,
        disabled,
      });
      onUpdated(res.serviceAccount);
    } catch (err) {
      setFormError(getErrorMessage(err, 'Failed to update'));
    }
  }

  return (
    <Dialog open={account !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Service Account</DialogTitle>
          {account && <DialogDescription className="font-mono">{account.name}</DialogDescription>}
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea rows={2} maxLength={500} {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="operator">Operator</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Existing tokens with a higher role are automatically downgraded at use time.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="sa-disabled" checked={disabled} onCheckedChange={setDisabled} />
              <Label htmlFor="sa-disabled" className="font-normal cursor-pointer">
                Disabled — all tokens belonging to this service account stop working
              </Label>
            </div>
            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

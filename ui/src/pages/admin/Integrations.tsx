import { useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
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
import { TrashIcon, PencilIcon } from '../../components/Icons';

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
};

const ROLE_BADGE: Record<UserRole, string> = {
  admin: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  operator: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  viewer: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
};

function roleLessThanOrEqual(child: UserRole, parent: UserRole): boolean {
  const rank: Record<UserRole, number> = { admin: 3, operator: 2, viewer: 1 };
  return rank[child] <= rank[parent];
}

export default function Integrations() {
  const { user: currentUser } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
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
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function handleRevokeToken(token: ApiTokenRecord) {
    if (!confirm(`Revoke token "${token.name}"? Any tool using it will stop working immediately.`)) {
      return;
    }
    try {
      await deleteApiToken(token.id);
      setTokens((prev) => prev.filter((t) => t.id !== token.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke token');
    }
  }

  async function handleDeleteSa(sa: ServiceAccount) {
    const tokenCount = sa._count?.apiTokens ?? 0;
    const message = tokenCount
      ? `Delete service account "${sa.name}"? This will revoke ${tokenCount} token${tokenCount === 1 ? '' : 's'} immediately.`
      : `Delete service account "${sa.name}"?`;
    if (!confirm(message)) return;
    try {
      await deleteServiceAccount(sa.id);
      setAccounts((prev) => prev.filter((a) => a.id !== sa.id));
      // Tokens are cascaded server-side; reflect that in UI too.
      setTokens((prev) => prev.filter((t) => t.serviceAccountId !== sa.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete service account');
    }
  }

  if (!isAdmin(currentUser)) {
    return (
      <div className="p-6">
        <div className="panel text-center py-12">
          <p className="text-red-400">Access denied. Admin privileges required.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-slate-700 rounded" />
          <div className="h-32 bg-slate-800 rounded-lg" />
          <div className="h-32 bg-slate-800 rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-8">
      <div>
        <p className="text-slate-400 text-sm">
          Manage credentials and connections for tools that talk to BRIDGEPORT.
        </p>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
          <p className="text-red-400">{error}</p>
        </div>
      )}

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

      <ComingSoonSection
        title="Webhooks"
        description="Outbound HTTP callbacks when events happen in BRIDGEPORT."
      />
      <ComingSoonSection
        title="OAuth Apps"
        description="Let third-party tools sign users in via BRIDGEPORT."
      />

      {showCreateToken && (
        <CreateTokenModal
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
      )}

      {newTokenValue && (
        <TokenRevealModal token={newTokenValue} onClose={() => setNewTokenValue(null)} />
      )}

      {showCreateSa && (
        <CreateServiceAccountModal
          onClose={() => setShowCreateSa(false)}
          onCreated={(sa) => {
            setAccounts((prev) => [sa, ...prev]);
            setShowCreateSa(false);
          }}
        />
      )}

      {editingSa && (
        <EditServiceAccountModal
          account={editingSa}
          onClose={() => setEditingSa(null)}
          onUpdated={(sa) => {
            setAccounts((prev) => prev.map((a) => (a.id === sa.id ? sa : a)));
            setEditingSa(null);
          }}
        />
      )}
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
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-white">API Tokens</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Bearer credentials for scripts, CI/CD, and other tools.
          </p>
        </div>
        <button className="btn btn-primary" onClick={onCreate}>
          New Token
        </button>
      </div>

      {tokens.length === 0 ? (
        <div className="panel text-center py-8">
          <p className="text-slate-400 text-sm">No API tokens yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {tokens.map((t) => (
            <TokenRow key={t.id} token={t} onRevoke={() => onRevoke(t)} />
          ))}
        </div>
      )}
    </section>
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
    <div className="panel">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-white truncate">{token.name}</h3>
            <span className={`px-2 py-0.5 text-[10px] rounded-full border ${ROLE_BADGE[token.role]}`}>
              {ROLE_LABELS[token.role]}
            </span>
            {expired && (
              <span className="px-2 py-0.5 text-[10px] rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
                Expired
              </span>
            )}
            {token.serviceAccount?.disabled && (
              <span className="px-2 py-0.5 text-[10px] rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                Owner disabled
              </span>
            )}
          </div>
          <div className="text-xs text-slate-400 mt-1 space-x-3">
            <span>Owner: {ownerLabel}</span>
            <span>Scope: {token.allEnvironments
              ? 'All environments'
              : token.environments.map((e) => e.environment.name).join(', ') || '—'}
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-1 space-x-3">
            {token.tokenPrefix && <span className="font-mono">{token.tokenPrefix}…</span>}
            <span>Created {formatDistanceToNow(new Date(token.createdAt), { addSuffix: true })}</span>
            {token.lastUsedAt ? (
              <span>Last used {formatDistanceToNow(new Date(token.lastUsedAt), { addSuffix: true })}</span>
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
        <button
          onClick={onRevoke}
          className="p-1.5 text-slate-400 hover:text-red-400 rounded"
          title="Revoke"
        >
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Create Token Modal
// ============================================================
function CreateTokenModal({
  users,
  accounts,
  environments,
  currentUserRole,
  onClose,
  onCreated,
}: {
  users: User[];
  accounts: ServiceAccount[];
  environments: Environment[];
  currentUserRole: UserRole;
  onClose: () => void;
  onCreated: (token: string, record: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [ownerKind, setOwnerKind] = useState<'user' | 'service-account'>('service-account');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [ownerSaId, setOwnerSaId] = useState('');
  const [role, setRole] = useState<UserRole>('viewer');
  const [scopeKind, setScopeKind] = useState<'all' | 'specific'>('all');
  const [envIds, setEnvIds] = useState<Set<string>>(new Set());
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Compute the role ceiling. The minted token's role can't exceed the owner's,
  // and the admin can't grant a role above their own (UI enforcement).
  const ownerRole: UserRole | null = useMemo(() => {
    if (ownerKind === 'user') {
      return (users.find((u) => u.id === ownerUserId)?.role ?? null) as UserRole | null;
    }
    return (accounts.find((a) => a.id === ownerSaId)?.role ?? null) as UserRole | null;
  }, [ownerKind, ownerUserId, ownerSaId, users, accounts]);

  const roleCeiling: UserRole = ownerRole && roleLessThanOrEqual(ownerRole, currentUserRole) ? ownerRole : currentUserRole;
  const availableRoles: UserRole[] = (['viewer', 'operator', 'admin'] as UserRole[]).filter(
    (r) => roleLessThanOrEqual(r, roleCeiling)
  );

  // If current role choice is no longer allowed, snap down.
  useEffect(() => {
    if (!availableRoles.includes(role)) {
      setRole(availableRoles[availableRoles.length - 1] ?? 'viewer');
    }
  }, [availableRoles, role]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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

    setSubmitting(true);
    try {
      const res = await createApiToken({
        name: name.trim(),
        ownerUserId: ownerKind === 'user' ? ownerUserId : undefined,
        ownerServiceAccountId: ownerKind === 'service-account' ? ownerSaId : undefined,
        role,
        allEnvironments: scopeKind === 'all',
        environmentIds: scopeKind === 'specific' ? Array.from(envIds) : undefined,
        expiresInDays,
      });
      onCreated(res.token, res.tokenRecord);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create token');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-white mb-4">New API Token</h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ci-deploy-staging"
              className="input"
              required
              minLength={1}
              maxLength={100}
            />
            <p className="text-xs text-slate-500 mt-1">A label so you can identify this token later.</p>
          </div>

          <div>
            <label className="block text-sm text-slate-400 mb-1">Owner type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOwnerKind('service-account')}
                className={`flex-1 px-3 py-2 rounded border text-sm ${
                  ownerKind === 'service-account'
                    ? 'border-brand-600 bg-brand-600/10 text-white'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                Service account
              </button>
              <button
                type="button"
                onClick={() => setOwnerKind('user')}
                className={`flex-1 px-3 py-2 rounded border text-sm ${
                  ownerKind === 'user'
                    ? 'border-brand-600 bg-brand-600/10 text-white'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                User
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Service accounts survive admin turnover — recommended for tools and pipelines.
            </p>
          </div>

          {ownerKind === 'service-account' ? (
            <div>
              <label className="block text-sm text-slate-400 mb-1">Service account</label>
              <select
                value={ownerSaId}
                onChange={(e) => setOwnerSaId(e.target.value)}
                className="input"
                required
              >
                <option value="">Choose one…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id} disabled={a.disabled}>
                    {a.name} ({ROLE_LABELS[a.role]}){a.disabled ? ' — disabled' : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="block text-sm text-slate-400 mb-1">User</label>
              <select
                value={ownerUserId}
                onChange={(e) => setOwnerUserId(e.target.value)}
                className="input"
                required
              >
                <option value="">Choose one…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name || u.email} ({ROLE_LABELS[u.role]})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm text-slate-400 mb-1">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="input"
              disabled={availableRoles.length === 0}
            >
              {availableRoles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            {ownerRole && (
              <p className="text-xs text-slate-500 mt-1">
                Capped at the owner's role ({ROLE_LABELS[ownerRole]}).
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm text-slate-400 mb-2">Environment scope</label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input
                  type="radio"
                  name="scope"
                  checked={scopeKind === 'all'}
                  onChange={() => setScopeKind('all')}
                />
                All environments
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input
                  type="radio"
                  name="scope"
                  checked={scopeKind === 'specific'}
                  onChange={() => setScopeKind('specific')}
                />
                Specific environments
              </label>
            </div>
            {scopeKind === 'specific' && (
              <div className="mt-2 border border-slate-700 rounded p-2 max-h-40 overflow-y-auto space-y-1">
                {environments.length === 0 ? (
                  <p className="text-xs text-slate-500 px-1">No environments exist yet.</p>
                ) : (
                  environments.map((env) => (
                    <label
                      key={env.id}
                      className="flex items-center gap-2 text-sm text-slate-300 px-1 py-0.5 hover:bg-slate-800 rounded cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={envIds.has(env.id)}
                        onChange={(e) => {
                          const next = new Set(envIds);
                          if (e.target.checked) next.add(env.id);
                          else next.delete(env.id);
                          setEnvIds(next);
                        }}
                      />
                      {env.name}
                    </label>
                  ))
                )}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm text-slate-400 mb-1">Expires in (days)</label>
            <input
              type="number"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
              min={1}
              max={365}
              className="input"
              required
            />
            <p className="text-xs text-slate-500 mt-1">Max 365 days. Tokens cannot live forever.</p>
          </div>

          {formError && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
              {formError}
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Token'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TokenRevealModal({ token, onClose }: { token: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-lg p-6">
        <h3 className="text-lg font-semibold text-white mb-2">Token Created</h3>
        <p className="text-sm text-amber-400 mb-3">
          Copy this token now. It will not be shown again.
        </p>
        <div className="bg-slate-950 border border-slate-700 rounded p-3 font-mono text-xs text-slate-200 break-all">
          {token}
        </div>
        <div className="flex gap-2 justify-end mt-4">
          <button className="btn btn-ghost" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
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
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-white">Service Accounts</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Machine identities for tools. Tokens minted against a service account survive owner turnover.
          </p>
        </div>
        <button className="btn btn-primary" onClick={onCreate}>
          New Service Account
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="panel text-center py-8">
          <p className="text-slate-400 text-sm">No service accounts yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((sa) => (
            <div key={sa.id} className="panel">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-white font-mono truncate">{sa.name}</h3>
                    <span className={`px-2 py-0.5 text-[10px] rounded-full border ${ROLE_BADGE[sa.role]}`}>
                      {ROLE_LABELS[sa.role]}
                    </span>
                    {sa.disabled && (
                      <span className="px-2 py-0.5 text-[10px] rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                        Disabled
                      </span>
                    )}
                  </div>
                  {sa.description && (
                    <p className="text-sm text-slate-400 mt-1">{sa.description}</p>
                  )}
                  <div className="text-xs text-slate-500 mt-1 space-x-3">
                    <span>{sa._count?.apiTokens ?? 0} token{(sa._count?.apiTokens ?? 0) === 1 ? '' : 's'}</span>
                    <span>Created {formatDistanceToNow(new Date(sa.createdAt), { addSuffix: true })}</span>
                    {sa.createdBy && <span>by {sa.createdBy.name || sa.createdBy.email}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onEdit(sa)}
                    className="p-1.5 text-slate-400 hover:text-white rounded"
                    title="Edit"
                  >
                    <PencilIcon className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => onDelete(sa)}
                    className="p-1.5 text-slate-400 hover:text-red-400 rounded"
                    title="Delete"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CreateServiceAccountModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (sa: ServiceAccount) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [role, setRole] = useState<UserRole>('viewer');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await createServiceAccount({
        name: name.trim(),
        description: description.trim() || undefined,
        role,
      });
      onCreated(res.serviceAccount);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create service account');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md p-6">
        <h3 className="text-lg font-semibold text-white mb-4">New Service Account</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ci-deploy-staging"
              className="input"
              pattern="[a-z0-9][a-z0-9_-]*"
              required
              maxLength={64}
            />
            <p className="text-xs text-slate-500 mt-1">
              Lowercase letters, digits, hyphens, underscores. Must start with a letter or digit.
            </p>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Description (optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="GitHub Actions deployer for staging"
              className="input"
              rows={2}
              maxLength={500}
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="input"
            >
              <option value="viewer">Viewer — Read-only</option>
              <option value="operator">Operator — Deploy and manage services</option>
              <option value="admin">Admin — Full access</option>
            </select>
            <p className="text-xs text-slate-500 mt-1">
              Tokens minted against this service account are capped at this role.
            </p>
          </div>
          {formError && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
              {formError}
            </div>
          )}
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditServiceAccountModal({
  account,
  onClose,
  onUpdated,
}: {
  account: ServiceAccount;
  onClose: () => void;
  onUpdated: (sa: ServiceAccount) => void;
}) {
  const [description, setDescription] = useState(account.description ?? '');
  const [role, setRole] = useState<UserRole>(account.role);
  const [disabled, setDisabled] = useState(account.disabled);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await updateServiceAccount(account.id, {
        description: description.trim() || undefined,
        role,
        disabled,
      });
      onUpdated(res.serviceAccount);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md p-6">
        <h3 className="text-lg font-semibold text-white mb-1">Edit Service Account</h3>
        <p className="text-sm text-slate-500 mb-4 font-mono">{account.name}</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input"
              rows={2}
              maxLength={500}
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="input"
            >
              <option value="viewer">Viewer</option>
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
            <p className="text-xs text-slate-500 mt-1">
              Existing tokens with a higher role are automatically downgraded at use time.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={disabled}
              onChange={(e) => setDisabled(e.target.checked)}
            />
            Disabled — all tokens belonging to this service account stop working
          </label>
          {formError && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
              {formError}
            </div>
          )}
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ComingSoonSection({ title, description }: { title: string; description: string }) {
  return (
    <section className="opacity-60">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <span className="px-2 py-0.5 text-[10px] rounded-full bg-slate-700/50 text-slate-400 border border-slate-700">
          Coming soon
        </span>
      </div>
      <p className="text-xs text-slate-500">{description}</p>
    </section>
  );
}

import { useEffect, useState } from 'react';
import { useAuthStore, isAdmin } from '../../lib/store';
import {
  listUsers,
  getActiveUsers,
  createUser,
  updateUser,
  deleteUser,
  changeUserPassword,
  type User,
  type UserRole,
} from '../../lib/api';
import { formatDistanceToNow } from 'date-fns';
import { PencilIcon, TrashIcon, KeyIcon } from '../../components/Icons';

const roleLabels: Record<UserRole, string> = {
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
};

const roleBadgeColors: Record<UserRole, string> = {
  admin: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  operator: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  viewer: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
};

export default function Users() {
  const { user: currentUser } = useAuthStore();
  const [users, setUsers] = useState<User[]>([]);
  const [activeUserIds, setActiveUserIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create user modal
  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('viewer');
  const [creating, setCreating] = useState(false);

  // Edit user modal
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('viewer');
  const [saving, setSaving] = useState(false);

  // Change password modal
  const [passwordUser, setPasswordUser] = useState<User | null>(null);
  const [newUserPassword, setNewUserPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const [usersRes, activeRes] = await Promise.all([
        listUsers(),
        getActiveUsers(),
      ]);
      setUsers(usersRes.users);
      setActiveUserIds(new Set(activeRes.activeUsers.map((u) => u.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const { user } = await createUser({
        email: newEmail,
        password: newPassword,
        name: newName || undefined,
        role: newRole,
      });
      setUsers((prev) => [user, ...prev]);
      setShowCreate(false);
      setNewEmail('');
      setNewPassword('');
      setNewName('');
      setNewRole('viewer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;

    setSaving(true);
    setError(null);
    try {
      const { user } = await updateUser(editingUser.id, {
        name: editName || undefined,
        role: editRole,
      });
      setUsers((prev) => prev.map((u) => (u.id === user.id ? user : u)));
      setEditingUser(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (user: User) => {
    if (!confirm(`Are you sure you want to delete ${user.email}?`)) return;

    setError(null);
    try {
      await deleteUser(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordUser) return;

    setChangingPassword(true);
    setError(null);
    try {
      await changeUserPassword(passwordUser.id, {
        newPassword: newUserPassword,
      });
      setPasswordUser(null);
      setNewUserPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setChangingPassword(false);
    }
  };

  const openEditModal = (user: User) => {
    setEditingUser(user);
    setEditName(user.name || '');
    setEditRole(user.role);
  };

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
        <div className="animate-pulse">
          <div className="h-8 w-32 bg-slate-700 rounded mb-5"></div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-slate-800 rounded-lg"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-end mb-5">
        <button onClick={() => setShowCreate(true)} className="btn btn-primary">
          Add User
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {/* Create User Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Add User</h3>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Email</label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  minLength={8}
                  className="input"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Name (optional)</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="John Doe"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Role</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as UserRole)}
                  className="input"
                >
                  <option value="viewer">Viewer - Read-only access</option>
                  <option value="operator">Operator - Can deploy and manage services</option>
                  <option value="admin">Admin - Full access</option>
                </select>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={creating} className="btn btn-primary">
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Edit User</h3>
            <form onSubmit={handleEdit} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Email</label>
                <input
                  type="email"
                  value={editingUser.email}
                  className="input bg-slate-800"
                  disabled
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="John Doe"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Role</label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as UserRole)}
                  className="input"
                  disabled={editingUser.id === currentUser?.id}
                >
                  <option value="viewer">Viewer - Read-only access</option>
                  <option value="operator">Operator - Can deploy and manage services</option>
                  <option value="admin">Admin - Full access</option>
                </select>
                {editingUser.id === currentUser?.id && (
                  <p className="text-xs text-slate-500 mt-1">You cannot change your own role</p>
                )}
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="btn btn-primary">
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Change Password Modal */}
      {passwordUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Change Password</h3>
            <p className="text-slate-400 text-sm mb-4">
              Set a new password for {passwordUser.email}
            </p>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">New Password</label>
                <input
                  type="password"
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  minLength={8}
                  className="input"
                  required
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setPasswordUser(null);
                    setNewUserPassword('');
                  }}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
                <button type="submit" disabled={changingPassword} className="btn btn-primary">
                  {changingPassword ? 'Changing...' : 'Change Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Active Users Summary */}
      {activeUserIds.size > 0 && (
        <div className="mb-6 p-4 bg-slate-800/50 border border-slate-700 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <h3 className="text-sm font-medium text-white">
              {activeUserIds.size} Active User{activeUserIds.size !== 1 ? 's' : ''}
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {users
              .filter((u) => activeUserIds.has(u.id))
              .map((u) => (
                <span
                  key={u.id}
                  className="px-2 py-1 text-xs rounded-full bg-slate-700 text-slate-300"
                >
                  {u.name || u.email}
                </span>
              ))}
          </div>
        </div>
      )}

      {/* Users List */}
      <div className="space-y-3">
        {users.map((user) => (
          <div key={user.id} className="panel">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center text-white font-medium">
                  {user.name?.[0]?.toUpperCase() || user.email[0].toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-white">{user.name || user.email}</h3>
                    <span
                      className={`px-2 py-0.5 text-xs rounded-full border ${roleBadgeColors[user.role]}`}
                    >
                      {roleLabels[user.role]}
                    </span>
                    {activeUserIds.has(user.id) && (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                        Online
                      </span>
                    )}
                    {user.id === currentUser?.id && (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
                        You
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-400">{user.email}</p>
                  {user.createdAt && (
                    <p className="text-xs text-slate-500 mt-1">
                      Joined{' '}
                      {formatDistanceToNow(new Date(user.createdAt), {
                        addSuffix: true,
                      })}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => openEditModal(user)}
                  className="p-1.5 text-slate-400 hover:text-white rounded"
                  title="Edit"
                >
                  <PencilIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setPasswordUser(user)}
                  className="p-1.5 text-slate-400 hover:text-white rounded"
                  title="Change Password"
                >
                  <KeyIcon className="w-4 h-4" />
                </button>
                {user.id !== currentUser?.id && (
                  <button
                    onClick={() => handleDelete(user)}
                    className="p-1.5 text-slate-400 hover:text-red-400 rounded"
                    title="Delete"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}

        {users.length === 0 && (
          <div className="panel text-center py-12">
            <p className="text-slate-400">No users found</p>
          </div>
        )}
      </div>
    </div>
  );
}

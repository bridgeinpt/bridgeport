import { Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuthStore, useAppStore, isAdmin } from '../lib/store';
import { listEnvironments, changeUserPassword, updateUser, type Environment } from '../lib/api';
import {
  HomeIcon,
  ServerIcon,
  CubeIcon,
  KeyIcon,
  FileIcon,
  RegistryIcon,
  DatabaseIcon,
  ActivityIcon,
  UsersIcon,
  SettingsIcon,
  InfoIcon,
  LogoutIcon,
  UserIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from './Icons';

// Inline bell icon for navigation (without import conflict)
function NavBellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
      />
    </svg>
  );
}
import NotificationBell from './NotificationBell';

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

interface NavGroup {
  name: string;
  items: NavItem[];
}

// Inline icons for orchestration features
function ImageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}

function PlanIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
      />
    </svg>
  );
}

const navigationGroups: NavGroup[] = [
  {
    name: 'Operations',
    items: [
      { name: 'Dashboard', href: '/', icon: HomeIcon },
      { name: 'Services', href: '/services', icon: CubeIcon },
      { name: 'Servers', href: '/servers', icon: ServerIcon },
    ],
  },
  {
    name: 'Orchestration',
    items: [
      { name: 'Managed Images', href: '/managed-images', icon: ImageIcon },
      { name: 'Deployment Plans', href: '/deployment-plans', icon: PlanIcon },
    ],
  },
  {
    name: 'Configuration',
    items: [
      { name: 'Secrets', href: '/secrets', icon: KeyIcon },
      { name: 'Config Files', href: '/config-files', icon: FileIcon },
      { name: 'Registries', href: '/registries', icon: RegistryIcon },
    ],
  },
  {
    name: 'Data',
    items: [{ name: 'Databases', href: '/databases', icon: DatabaseIcon }],
  },
  {
    name: 'System',
    items: [
      { name: 'Audit Logs', href: '/activity', icon: ActivityIcon },
      { name: 'Users', href: '/users', icon: UsersIcon, adminOnly: true },
      { name: 'Environment Config', href: '/settings', icon: SettingsIcon },
      { name: 'Notifications Config', href: '/admin/notifications', icon: NavBellIcon, adminOnly: true },
    ],
  },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { user, setUser, logout } = useAuthStore();
  const { selectedEnvironment, setSelectedEnvironment, clearSelectedEnvironment } = useAppStore();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  // Account modal state
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountTab, setAccountTab] = useState<'profile' | 'password'>('profile');
  const [editName, setEditName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const openAccountModal = () => {
    setEditName(user?.name || '');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
    setSuccess(null);
    setAccountTab('profile');
    setShowAccountModal(true);
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { user: updatedUser } = await updateUser(user.id, { name: editName || undefined });
      setUser({ ...user, name: updatedUser.name });
      setSuccess('Profile updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await changeUserPassword(user.id, {
        currentPassword,
        newPassword,
      });
      setSuccess('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    listEnvironments().then(({ environments }) => {
      setEnvironments(environments);

      if (selectedEnvironment) {
        // Validate persisted environment still exists
        const stillExists = environments.some((env) => env.id === selectedEnvironment.id);
        if (!stillExists) {
          // Environment was deleted, clear and select first available
          if (environments.length > 0) {
            setSelectedEnvironment(environments[0]);
          } else {
            clearSelectedEnvironment();
          }
        }
      } else if (environments.length > 0) {
        // No environment selected, select first one
        setSelectedEnvironment(environments[0]);
      }
    });
  }, []); // Only run on mount

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 border-r border-slate-700 flex flex-col h-screen">
        <div className="p-4 border-b border-slate-700 flex-shrink-0">
          <Link to="/">
            <img src="/logo.svg" alt="BridgePort" className="h-20" />
          </Link>
        </div>

        {/* Environment selector */}
        <div className="p-4 border-b border-slate-700 flex-shrink-0">
          <label className="text-xs text-slate-400 uppercase tracking-wide">
            Environment
          </label>
          <select
            value={selectedEnvironment?.id || ''}
            onChange={(e) => {
              const env = environments.find((env) => env.id === e.target.value);
              setSelectedEnvironment(env || null);
            }}
            className="mt-1 w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white"
          >
            {environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
        </div>

        <nav className="flex-1 p-4 space-y-4 overflow-y-auto min-h-0">
          {navigationGroups.map((group) => {
            const visibleItems = group.items.filter(
              (item) => !item.adminOnly || isAdmin(user)
            );
            if (visibleItems.length === 0) return null;

            const isCollapsed = collapsedGroups.has(group.name);

            return (
              <div key={group.name}>
                <button
                  onClick={() => toggleGroup(group.name)}
                  className="flex items-center justify-between w-full text-xs text-slate-500 uppercase tracking-wider font-medium mb-2 px-3 hover:text-slate-400 transition-colors"
                >
                  <span>{group.name}</span>
                  {isCollapsed ? (
                    <ChevronRightIcon className="w-4 h-4" />
                  ) : (
                    <ChevronDownIcon className="w-4 h-4" />
                  )}
                </button>
                {!isCollapsed && (
                  <div className="space-y-1">
                    {visibleItems.map((item) => {
                      const isActive = location.pathname === item.href;
                      return (
                        <Link
                          key={item.name}
                          to={item.href}
                          className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                            isActive
                              ? 'bg-primary-600 text-white'
                              : 'text-slate-300 hover:bg-slate-800'
                          }`}
                        >
                          <item.icon className="w-5 h-5" />
                          {item.name}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-700 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="text-sm min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-white font-medium truncate">{user?.name || user?.email}</p>
                {user?.role && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-700 text-slate-300 uppercase flex-shrink-0">
                    {user.role}
                  </span>
                )}
              </div>
              <p className="text-slate-400 text-xs truncate">{user?.email}</p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <NotificationBell />
              <button
                onClick={openAccountModal}
                className="text-slate-400 hover:text-white"
                title="My Account"
                aria-label="My Account"
              >
                <UserIcon className="w-5 h-5" />
              </button>
              <Link
                to="/about"
                className="text-slate-400 hover:text-white"
                title="About BridgePort"
                aria-label="About BridgePort"
              >
                <InfoIcon className="w-5 h-5" />
              </Link>
              <button
                onClick={() => {
                  logout();
                  window.location.href = '/login';
                }}
                className="text-slate-400 hover:text-white"
                aria-label="Logout"
              >
                <LogoutIcon className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">{children}</main>

      {/* Account Modal */}
      {showAccountModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">My Account</h3>
              <button
                onClick={() => setShowAccountModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-700 mb-4">
              <button
                onClick={() => { setAccountTab('profile'); setError(null); setSuccess(null); }}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                  accountTab === 'profile'
                    ? 'border-primary-500 text-primary-400'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                Profile
              </button>
              <button
                onClick={() => { setAccountTab('password'); setError(null); setSuccess(null); }}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                  accountTab === 'password'
                    ? 'border-primary-500 text-primary-400'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                Change Password
              </button>
            </div>

            {error && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            {success && (
              <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                <p className="text-green-400 text-sm">{success}</p>
              </div>
            )}

            {accountTab === 'profile' && (
              <form onSubmit={handleUpdateProfile} className="space-y-4">
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Email</label>
                  <input
                    type="email"
                    value={user?.email || ''}
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
                    placeholder="Your name"
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Role</label>
                  <input
                    type="text"
                    value={user?.role || ''}
                    className="input bg-slate-800 capitalize"
                    disabled
                  />
                </div>
                <div className="flex justify-end pt-2">
                  <button type="submit" disabled={saving} className="btn btn-primary">
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </form>
            )}

            {accountTab === 'password' && (
              <form onSubmit={handleChangePassword} className="space-y-4">
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Current Password</label>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="input"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">New Password</label>
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
                  <label className="block text-sm text-slate-400 mb-1">Confirm New Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="input"
                    required
                  />
                </div>
                <div className="flex justify-end pt-2">
                  <button type="submit" disabled={saving} className="btn btn-primary">
                    {saving ? 'Changing...' : 'Change Password'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

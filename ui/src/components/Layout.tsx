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
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  ChartIcon,
  HeartPulseIcon,
  NetworkIcon,
  CogIcon,
} from './Icons';
import TopBar from './TopBar';

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

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

interface NavGroup {
  name: string;
  items: NavItem[];
  isGlobal?: boolean; // Not dependent on selected environment
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

function CommandIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}

function CloudIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
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
    name: 'Monitoring',
    items: [
      { name: 'Overview', href: '/monitoring', icon: ChartIcon },
      { name: 'Health Checks', href: '/monitoring/health', icon: HeartPulseIcon },
      { name: 'Agents & SSH', href: '/monitoring/agents', icon: NetworkIcon },
    ],
  },
  {
    name: 'Orchestration',
    items: [
      { name: 'Managed Images', href: '/managed-images', icon: ImageIcon },
      { name: 'Deployment Plans', href: '/deployment-plans', icon: PlanIcon },
      { name: 'Registries', href: '/registries', icon: RegistryIcon },
    ],
  },
  {
    name: 'Data',
    items: [
      { name: 'Databases', href: '/databases', icon: DatabaseIcon },
      { name: 'Audit Logs', href: '/activity', icon: ActivityIcon },
    ],
  },
  {
    name: 'Configuration',
    items: [
      { name: 'Secrets', href: '/secrets', icon: KeyIcon },
      { name: 'Config Files', href: '/config-files', icon: FileIcon },
      { name: 'Environment', href: '/settings', icon: SettingsIcon },
    ],
  },
  {
    name: 'Global Settings',
    isGlobal: true,
    items: [
      { name: 'System', href: '/settings/system', icon: CogIcon, adminOnly: true },
      { name: 'Service Types', href: '/settings/service-types', icon: CommandIcon, adminOnly: true },
      { name: 'Spaces', href: '/settings/spaces', icon: CloudIcon, adminOnly: true },
      { name: 'Users', href: '/users', icon: UsersIcon, adminOnly: true },
      { name: 'Notifications', href: '/admin/notifications', icon: NavBellIcon, adminOnly: true },
    ],
  },
];

// Separate environment-dependent and global navigation groups
const envDependentGroups = navigationGroups.filter(g => !g.isGlobal);
const globalGroups = navigationGroups.filter(g => g.isGlobal);

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { user, setUser } = useAuthStore();
  const { selectedEnvironment, setSelectedEnvironment, clearSelectedEnvironment, sidebarCollapsed, toggleSidebar } = useAppStore();
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
    <div className="h-screen flex overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`bg-slate-900 border-r border-slate-700 flex flex-col flex-shrink-0 transition-all duration-200 ${
          sidebarCollapsed ? 'w-14' : 'w-56'
        }`}
      >
        {/* Logo area - aligned with top bar height */}
        <div className="h-12 flex items-center justify-center border-b border-slate-700 flex-shrink-0">
          <Link to="/" className="flex items-center">
            {sidebarCollapsed ? (
              // Compact icon when collapsed - show just the crane part
              <svg width="28" height="28" viewBox="0 0 60 60" className="text-brand-600">
                <rect x="5" y="5" width="6" height="30" fill="currentColor" />
                <rect x="11" y="5" width="30" height="6" fill="currentColor" />
                <line x1="41" y1="8" x2="41" y2="30" stroke="currentColor" strokeWidth="3" />
                <path d="M38 30 L41 40 L44 30" fill="currentColor" />
                <circle cx="41" cy="27" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            ) : (
              <img src="/logo.svg" alt="BridgePort" className="h-12" />
            )}
          </Link>
        </div>

        {/* Environment selector - hidden when collapsed */}
        {!sidebarCollapsed && (
          <div className="p-3 border-b border-slate-700 flex-shrink-0">
            <label className="text-[10px] text-slate-500 uppercase tracking-wider">
              Environment
            </label>
            <select
              value={selectedEnvironment?.id || ''}
              onChange={(e) => {
                const env = environments.find((env) => env.id === e.target.value);
                setSelectedEnvironment(env || null);
              }}
              className="mt-1 w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-white"
            >
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <nav className="flex-1 p-2 overflow-y-auto min-h-0 flex flex-col">
          {/* Environment-dependent navigation */}
          <div className="space-y-3 flex-1">
            {envDependentGroups.map((group) => {
              const visibleItems = group.items.filter(
                (item) => !item.adminOnly || isAdmin(user)
              );
              if (visibleItems.length === 0) return null;

              const isGroupCollapsed = collapsedGroups.has(group.name);

              return (
                <div key={group.name}>
                  {/* Group header - hidden when sidebar collapsed */}
                  {!sidebarCollapsed && (
                    <button
                      onClick={() => toggleGroup(group.name)}
                      className="flex items-center justify-between w-full text-[10px] text-slate-500 uppercase tracking-wider font-medium mb-1 px-2 hover:text-slate-400 transition-colors"
                    >
                      <span>{group.name}</span>
                      {isGroupCollapsed ? (
                        <ChevronRightIcon className="w-3 h-3" />
                      ) : (
                        <ChevronDownIcon className="w-3 h-3" />
                      )}
                    </button>
                  )}
                  {(!isGroupCollapsed || sidebarCollapsed) && (
                    <div className="space-y-0.5">
                      {visibleItems.map((item) => {
                        const isActive = location.pathname === item.href;
                        return (
                          <Link
                            key={item.name}
                            to={item.href}
                            className={`relative flex items-center gap-2 px-2 py-1.5 rounded transition-colors ${
                              isActive
                                ? 'bg-slate-800 text-white'
                                : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                            } ${sidebarCollapsed ? 'justify-center' : ''}`}
                            title={sidebarCollapsed ? item.name : undefined}
                          >
                            {/* Burgundy accent stripe for active items */}
                            {isActive && (
                              <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-brand-600 rounded-r" />
                            )}
                            <item.icon className="w-4 h-4 flex-shrink-0" />
                            {!sidebarCollapsed && (
                              <span className="text-sm">{item.name}</span>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Visual separator for global settings */}
          {globalGroups.some(g => g.items.some(item => !item.adminOnly || isAdmin(user))) && (
            <>
              <div className="my-3 border-t border-slate-700/50" />

              {/* Global navigation (not environment-dependent) */}
              <div className="space-y-3">
                {globalGroups.map((group) => {
                  const visibleItems = group.items.filter(
                    (item) => !item.adminOnly || isAdmin(user)
                  );
                  if (visibleItems.length === 0) return null;

                  const isGroupCollapsed = collapsedGroups.has(group.name);

                  return (
                    <div key={group.name}>
                      {/* Group header - hidden when sidebar collapsed */}
                      {!sidebarCollapsed && (
                        <button
                          onClick={() => toggleGroup(group.name)}
                          className="flex items-center justify-between w-full text-[10px] text-slate-500 uppercase tracking-wider font-medium mb-1 px-2 hover:text-slate-400 transition-colors"
                        >
                          <span>{group.name}</span>
                          {isGroupCollapsed ? (
                            <ChevronRightIcon className="w-3 h-3" />
                          ) : (
                            <ChevronDownIcon className="w-3 h-3" />
                          )}
                        </button>
                      )}
                      {(!isGroupCollapsed || sidebarCollapsed) && (
                        <div className="space-y-0.5">
                          {visibleItems.map((item) => {
                            const isActive = location.pathname === item.href;
                            return (
                              <Link
                                key={item.name}
                                to={item.href}
                                className={`relative flex items-center gap-2 px-2 py-1.5 rounded transition-colors ${
                                  isActive
                                    ? 'bg-slate-800 text-white'
                                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                                } ${sidebarCollapsed ? 'justify-center' : ''}`}
                                title={sidebarCollapsed ? item.name : undefined}
                              >
                                {/* Burgundy accent stripe for active items */}
                                {isActive && (
                                  <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-brand-600 rounded-r" />
                                )}
                                <item.icon className="w-4 h-4 flex-shrink-0" />
                                {!sidebarCollapsed && (
                                  <span className="text-sm">{item.name}</span>
                                )}
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </nav>

        {/* Collapse toggle at bottom */}
        <div className="p-2 border-t border-slate-700 flex-shrink-0">
          <button
            onClick={toggleSidebar}
            className="w-full flex items-center justify-center p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <ChevronLeftIcon className={`w-4 h-4 transition-transform ${sidebarCollapsed ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <TopBar onOpenAccount={openAccountModal} />

        {/* Main content */}
        <main className="flex-1 overflow-auto">{children}</main>
      </div>

      {/* Account Modal */}
      {showAccountModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl border border-slate-700 w-full max-w-md p-5">
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
                    ? 'border-brand-600 text-brand-500'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                Profile
              </button>
              <button
                onClick={() => { setAccountTab('password'); setError(null); setSuccess(null); }}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                  accountTab === 'password'
                    ? 'border-brand-600 text-brand-500'
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

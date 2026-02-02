import { Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuthStore, useAppStore, isAdmin } from '../lib/store';
import { listEnvironments, type Environment } from '../lib/api';
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
} from './Icons';

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
      { name: 'Settings', href: '/settings', icon: SettingsIcon },
    ],
  },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const { selectedEnvironment, setSelectedEnvironment, clearSelectedEnvironment } = useAppStore();
  const [environments, setEnvironments] = useState<Environment[]>([]);

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
      <aside className="w-64 bg-slate-900 border-r border-slate-700 flex flex-col">
        <div className="p-4 border-b border-slate-700">
          <img src="/logo.svg" alt="BridgePort" className="h-20" />
        </div>

        {/* Environment selector */}
        <div className="p-4 border-b border-slate-700">
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

        <nav className="flex-1 p-4 space-y-6 overflow-y-auto">
          {navigationGroups.map((group) => {
            const visibleItems = group.items.filter(
              (item) => !item.adminOnly || isAdmin(user)
            );
            if (visibleItems.length === 0) return null;

            return (
              <div key={group.name}>
                <h3 className="text-xs text-slate-500 uppercase tracking-wider font-medium mb-2 px-3">
                  {group.name}
                </h3>
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
              </div>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-700">
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <div className="flex items-center gap-2">
                <p className="text-white font-medium">{user?.name || user?.email}</p>
                {user?.role && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-700 text-slate-300 uppercase">
                    {user.role}
                  </span>
                )}
              </div>
              <p className="text-slate-400 text-xs">{user?.email}</p>
            </div>
            <div className="flex items-center gap-2">
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
    </div>
  );
}

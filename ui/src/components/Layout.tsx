import { Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuthStore, useAppStore, isAdmin } from '../lib/store';
import { listEnvironments, type Environment } from '../lib/api';

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

const navigation: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: HomeIcon },
  { name: 'Servers', href: '/servers', icon: ServerIcon },
  { name: 'Services', href: '/services', icon: CubeIcon },
  { name: 'Secrets', href: '/secrets', icon: KeyIcon },
  { name: 'Env Templates', href: '/env-templates', icon: DocumentIcon },
  { name: 'Config Files', href: '/config-files', icon: FileIcon },
  { name: 'Registries', href: '/registries', icon: RegistryIcon },
  { name: 'Databases', href: '/databases', icon: DatabaseIcon },
  { name: 'Activity', href: '/activity', icon: ActivityIcon },
  { name: 'Users', href: '/users', icon: UsersIcon, adminOnly: true },
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

        <nav className="flex-1 p-4 space-y-1">
          {navigation
            .filter((item) => !item.adminOnly || isAdmin(user))
            .map((item) => {
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
              >
                <InfoIcon className="w-5 h-5" />
              </Link>
              <button
                onClick={() => {
                  logout();
                  window.location.href = '/login';
                }}
                className="text-slate-400 hover:text-white"
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

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  );
}

function ServerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
    </svg>
  );
}

function CubeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  );
}

function KeyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
    </svg>
  );
}

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

function LogoutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
    </svg>
  );
}

function ActivityIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
    </svg>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function RegistryIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}

function DatabaseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  );
}

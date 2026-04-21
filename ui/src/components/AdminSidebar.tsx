import { Link, useLocation } from 'react-router-dom';
import {
  CogIcon,
  UsersIcon,
  ActivityIcon,
  InfoIcon,
} from './Icons';

// Inline icons for admin sidebar
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

function BellIcon({ className }: { className?: string }) {
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

function DatabaseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
      />
    </svg>
  );
}

function ArrowLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10 19l-7-7m0 0l7-7m-7 7h18"
      />
    </svg>
  );
}

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navigationItems: NavItem[] = [
  { name: 'About', href: '/admin/about', icon: InfoIcon },
  { name: 'System', href: '/admin/system', icon: CogIcon },
  { name: 'Service Types', href: '/admin/service-types', icon: CommandIcon },
  { name: 'Database Types', href: '/admin/database-types', icon: DatabaseIcon },
  { name: 'Storage', href: '/admin/storage', icon: CloudIcon },
  { name: 'Users', href: '/admin/users', icon: UsersIcon },
  { name: 'Audit', href: '/admin/audit', icon: ActivityIcon },
  { name: 'Notifications', href: '/admin/notifications', icon: BellIcon },
];

export default function AdminSidebar() {
  const location = useLocation();

  return (
    <aside className="bg-slate-900 border-r border-slate-700 flex flex-col flex-shrink-0 w-56">
      {/* Logo area */}
      <div className="h-12 flex items-center justify-center border-b border-slate-700 flex-shrink-0">
        <Link to="/" className="flex items-center" title="Back to App">
          <img src="/logo.png" alt="BRIDGEPORT" className="h-10" />
        </Link>
      </div>

      {/* Back to App button */}
      <div className="p-3 border-b border-slate-700 flex-shrink-0">
        <Link
          to="/"
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors text-sm"
        >
          <ArrowLeftIcon className="w-4 h-4" />
          <span>Back to App</span>
        </Link>
      </div>

      {/* Admin label */}
      <div className="px-4 py-3 flex-shrink-0">
        <span className="text-[10px] text-brand-600 uppercase tracking-wider font-medium">
          Admin Settings
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 overflow-y-auto min-h-0">
        <div className="space-y-0.5">
          {navigationItems.map((item) => {
            const isActive = location.pathname === item.href;
            return (
              <Link
                key={item.name}
                to={item.href}
                className={`relative flex items-center gap-2 px-2 py-1.5 rounded transition-colors ${
                  isActive
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {/* Burgundy accent stripe for active items */}
                {isActive && (
                  <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-brand-600 rounded-r" />
                )}
                <item.icon className="w-4 h-4 flex-shrink-0" />
                <span className={`text-sm ${isActive ? 'text-[#cc0000]' : ''}`}>{item.name}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}

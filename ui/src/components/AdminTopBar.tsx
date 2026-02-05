import { useAuthStore } from '../lib/store';
import { UserIcon, LogoutIcon } from './Icons';
import NotificationBell from './NotificationBell';
import Breadcrumbs from './Breadcrumbs';

// Terminal icon for CLI
function TerminalIcon({ className }: { className?: string }) {
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

interface AdminTopBarProps {
  onOpenAccount: () => void;
  onOpenCLI: () => void;
}

export default function AdminTopBar({ onOpenAccount, onOpenCLI }: AdminTopBarProps) {
  const { user, logout } = useAuthStore();

  return (
    <header className="h-12 flex-shrink-0 bg-slate-900 border-b border-slate-700 flex items-center justify-between px-4">
      {/* Left side: Breadcrumbs */}
      <div className="flex items-center min-w-0">
        <Breadcrumbs />
      </div>

      {/* Right side: User info & actions */}
      <div className="flex items-center gap-3">
        {/* User name and role */}
        <div className="hidden sm:flex items-center gap-2 text-sm">
          <span className="text-white truncate max-w-[150px]">
            {user?.name || user?.email}
          </span>
          {user?.role && (
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-700 text-slate-300 uppercase">
              {user.role}
            </span>
          )}
        </div>

        {/* Divider */}
        <div className="hidden sm:block w-px h-5 bg-slate-700" />

        {/* Action buttons */}
        <div className="flex items-center gap-1">
          <NotificationBell />
          <button
            onClick={onOpenCLI}
            className="icon-btn"
            title="CLI Tool"
            aria-label="CLI Tool"
          >
            <TerminalIcon className="w-4 h-4" />
          </button>
          <button
            onClick={onOpenAccount}
            className="icon-btn"
            title="My Account"
            aria-label="My Account"
          >
            <UserIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              logout();
              window.location.href = '/login';
            }}
            className="icon-btn"
            title="Logout"
            aria-label="Logout"
          >
            <LogoutIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
